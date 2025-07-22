import datetime
import os
import random
import ssl
import time
from xml.dom import minidom
from xml.etree.ElementTree import Element, SubElement, tostring

import arrow
import certifi
import geopy
import pandas as pd
import stravalib
from fit_tool.fit_file_builder import FitFileBuilder
from fit_tool.profile.messages.event_message import EventMessage
from fit_tool.profile.messages.file_id_message import FileIdMessage
from fit_tool.profile.messages.lap_message import LapMessage
from fit_tool.profile.messages.record_message import RecordMessage
from fit_tool.profile.messages.session_message import SessionMessage
from fit_tool.profile.profile_type import Event, EventType, FileType
from geopy.geocoders import Nominatim
from gpxtrackposter import track_loader
from polyline_processor import filter_out

from utils import get_logger

from .db import (
    convert_streams_to_flyby_dataframe,
    get_dataframe_from_strava_activities,
    get_dataframes_for_fit_tables,
    init_db,
    store_flyby_data,
    update_or_create_activities,
)
from .db import write_fit_dataframes as write_fit_dataframes

IGNORE_BEFORE_SAVING = os.getenv("IGNORE_BEFORE_SAVING", False)


geopy.geocoders.options.default_user_agent = "running-data-sync"
# reverse the location (lat, lon) -> location detail
ctx = ssl.create_default_context(cafile=certifi.where())
geopy.geocoders.options.default_ssl_context = ctx
g = Nominatim(user_agent="running-data-sync", timeout=10)


class Generator:
    def __init__(self, db_path):
        self.client = stravalib.Client()
        self.db_connection = init_db(db_path)
        self.logger = get_logger(self.__class__.__name__)

        self.client_id = ""
        self.client_secret = ""
        self.refresh_token = ""
        self.only_run = False

    def set_strava_config(self, client_id, client_secret, refresh_token):
        self.client_id = client_id
        self.client_secret = client_secret
        self.refresh_token = refresh_token

    def check_access(self):
        response = self.client.refresh_access_token(
            client_id=self.client_id,
            client_secret=self.client_secret,
            refresh_token=self.refresh_token,
        )
        # Update the authdata object
        self.access_token = response["access_token"]
        self.refresh_token = response["refresh_token"]

        self.client.access_token = response["access_token"]
        self.logger.info("Strava access token refreshed successfully.")

    def sync(self, force):
        """
        Sync activities from Strava to the local DuckDB database.
        """
        self.check_access()

        self.logger.info("Starting Strava DB sync.")
        if force:
            filters = {"before": datetime.datetime.now(datetime.timezone.utc)}
        else:
            # Use a raw SQL query to get the last activity's start_date
            last_activity_date_result = self.db_connection.execute("SELECT MAX(start_date) FROM activities").fetchone()
            last_activity_date = last_activity_date_result[0] if last_activity_date_result else None

            if last_activity_date:
                # The date from DB is timezone-aware, so we can parse it directly.
                last_activity_date = arrow.get(last_activity_date).datetime
                filters = {"after": last_activity_date}
            else:
                filters = {"before": datetime.datetime.now(datetime.timezone.utc)}

        strava_activities = list(self.client.get_activities(**filters))
        self.logger.info(f"Found {len(strava_activities)} new activities from Strava.")

        if not strava_activities:
            self.logger.info("No new activities to sync.")
            return

        # Convert to DataFrame and upsert
        activities_df = get_dataframe_from_strava_activities(strava_activities)
        updated_count = update_or_create_activities(self.db_connection, activities_df)
        self.logger.info(f"Synced {updated_count} activities to the database.")

        try:
            self.logger.info("Starting flyby data synchronization as part of main sync...")
            flyby_records = self.sync_flyby_data()
            if flyby_records > 0:
                self.logger.info(f"Successfully synced {flyby_records} flyby records.")
            else:
                self.logger.info("No new flyby data to sync.")
        except Exception as e:
            self.logger.warning(f"Flyby data synchronization failed: {e},but main sync completed successfully.")

    def _make_tcx_from_streams(self, activity, streams):
        # TCX XML structure
        root = Element("TrainingCenterDatabase")
        root.attrib = {
            "xmlns": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2",
            "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
            "xsi:schemaLocation": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd",  # noqa: E501
        }

        activities_node = SubElement(root, "Activities")
        activity_node = SubElement(activities_node, "Activity")
        activity_node.set("Sport", activity.type)

        # Activity ID (Start time in ISO format)
        activity_id_node = SubElement(activity_node, "Id")
        activity_id_node.text = activity.start_date.isoformat()

        # Lap
        lap_node = SubElement(activity_node, "Lap")
        lap_node.set("StartTime", activity.start_date.isoformat())

        total_time_seconds = SubElement(lap_node, "TotalTimeSeconds")
        total_time_seconds.text = str(activity.elapsed_time.total_seconds())

        distance_meters = SubElement(lap_node, "DistanceMeters")
        distance_meters.text = str(float(activity.distance))

        if activity.calories:
            calories = SubElement(lap_node, "Calories")
            calories.text = str(int(activity.calories))

        if streams.get("heartrate"):
            avg_hr = SubElement(lap_node, "AverageHeartRateBpm")
            avg_hr_val = SubElement(avg_hr, "Value")
            avg_hr_val.text = str(int(sum(s for s in streams["heartrate"].data) / len(streams["heartrate"].data)))

            max_hr = SubElement(lap_node, "MaximumHeartRateBpm")
            max_hr_val = SubElement(max_hr, "Value")
            max_hr_val.text = str(int(max(streams["heartrate"].data)))

        intensity = SubElement(lap_node, "Intensity")
        intensity.text = "Active"

        trigger_method = SubElement(lap_node, "TriggerMethod")
        trigger_method.text = "Manual"

        track_node = SubElement(lap_node, "Track")

        # Trackpoints
        time_stream = streams.get("time").data if streams.get("time") else []
        latlng_stream = streams.get("latlng").data if streams.get("latlng") else []
        alt_stream = streams.get("altitude").data if streams.get("altitude") else [0] * len(time_stream)
        hr_stream = streams.get("heartrate").data if streams.get("heartrate") else [0] * len(time_stream)

        for i, time_offset in enumerate(time_stream):
            trackpoint_node = SubElement(track_node, "Trackpoint")

            time_node = SubElement(trackpoint_node, "Time")
            time_node.text = (activity.start_date + datetime.timedelta(seconds=time_offset)).isoformat()

            if i < len(latlng_stream):
                position_node = SubElement(trackpoint_node, "Position")
                lat_node = SubElement(position_node, "LatitudeDegrees")
                lat_node.text = str(latlng_stream[i][0])
                lon_node = SubElement(position_node, "LongitudeDegrees")
                lon_node.text = str(latlng_stream[i][1])

            if i < len(alt_stream):
                alt_node = SubElement(trackpoint_node, "AltitudeMeters")
                alt_node.text = str(alt_stream[i])

            if i < len(hr_stream):
                hr_node = SubElement(trackpoint_node, "HeartRateBpm")
                hr_val_node = SubElement(hr_node, "Value")
                hr_val_node.text = str(hr_stream[i])

        # Creator
        creator_node = SubElement(activity_node, "Creator")
        creator_node.set("xsi:type", "Device_t")
        name_node = SubElement(creator_node, "Name")
        name_node.text = "Strava"

        # Pretty print XML
        xml_str = tostring(root, "utf-8")
        parsed_str = minidom.parseString(xml_str)
        return parsed_str.toprettyxml(indent="  ")

    def generate_missing_tcx(self, downloaded_ids):
        self.check_access()

        self.logger.info("Fetching all activities from Strava to check for missing TCX files...")
        activities = self.client.get_activities()  # Fetch all activities

        tcx_files = []

        activities_to_process = [a for a in activities if str(a.id) not in downloaded_ids]

        self.logger.info(f"Found {len(activities_to_process)} new activities to generate TCX for.")

        for activity in activities_to_process:
            try:
                self.logger.info(f"Processing activity: {activity.name} ({activity.id})")
                stream_types = ["time", "latlng", "altitude", "heartrate"]
                streams = self.client.get_activity_streams(activity.id, types=stream_types)

                if not streams.get("latlng") or not streams.get("time"):
                    self.logger.warning(f"Skipping activity {activity.id} due to missing latlng or time streams.")
                    continue

                tcx_content = self._make_tcx_from_streams(activity, streams)
                filename = f"{activity.id}.tcx"
                tcx_files.append((filename, tcx_content))

                # Rate limiting
                time.sleep(2)
            except Exception as e:
                self.logger.error(f"Failed to process activity {activity.id}: {e}", exc_info=True)

        return tcx_files

    def sync_from_data_dir(self, data_dir, file_suffix="gpx", activity_title_dict={}):
        loader = track_loader.TrackLoader()
        tracks = loader.load_tracks(
            data_dir,
            file_suffix=file_suffix,
            activity_title_dict=activity_title_dict,
        )
        self.logger.info(f"Found {len(tracks)} tracks from {data_dir}.")
        if not tracks:
            return

        self.sync_from_app(tracks)

    def sync_from_app(self, app_tracks):
        if not app_tracks:
            self.logger.info("No tracks to sync from app.")
            return

        activities_data = []
        for t in app_tracks:
            # Convert track object to a dictionary-like structure
            track_data = t.to_namedtuple()._asdict()
            record = {
                "run_id": track_data["id"],
                "name": track_data["name"],
                "distance": track_data["length"],
                "moving_time": track_data["moving_time"].total_seconds(),
                "elapsed_time": track_data["elapsed_time"].total_seconds(),
                "type": track_data["type"],
                "subtype": track_data["subtype"],
                "start_date": datetime.datetime.strptime(track_data["start_date"], "%Y-%m-%d %H:%M:%S"),
                "start_date_local": datetime.datetime.strptime(track_data["start_date_local"], "%Y-%m-%d %H:%M:%S"),
                "location_country": "",  # GPX/FIT files don't have this
                "summary_polyline": track_data["map"].summary_polyline,
                "average_heartrate": track_data["average_heartrate"],
                "average_speed": track_data["average_speed"],
                "elevation_gain": track_data["elevation_gain"],
            }
            activities_data.append(record)

        activities_df = pd.DataFrame(activities_data)
        updated_count = update_or_create_activities(self.db_connection, activities_df)
        self.logger.info(f"Synced {updated_count} activities to the database.")

    def load(self):
        """
        Loads activities from the database and calculates the running streak.
        """
        query = "SELECT * FROM activities ORDER BY start_date_local"
        activities_df = self.db_connection.execute(query).fetchdf()

        if self.only_run:
            activities_df = activities_df[activities_df["type"] == "Run"].copy()

        if activities_df.empty:
            return []

        # Calculate streak
        activities_df["start_date_local_date"] = pd.to_datetime(activities_df["start_date_local"]).dt.date
        activities_df = activities_df.sort_values("start_date_local_date")
        # Get the difference in days between consecutive runs
        activities_df["date_diff"] = (
            activities_df["start_date_local_date"].diff().apply(lambda x: x.days if pd.notna(x) else None)
        )
        # Identify the start of a new streak
        activities_df["new_streak"] = (activities_df["date_diff"] != 1).cumsum()
        # Calculate streak number within each group
        activities_df["streak"] = activities_df.groupby("new_streak").cumcount() + 1

        # Drop temporary columns
        activities_df = activities_df.drop(columns=["start_date_local_date", "date_diff", "new_streak"])

        # Polyline filtering
        if not IGNORE_BEFORE_SAVING:
            activities_df["summary_polyline"] = activities_df["summary_polyline"].apply(filter_out)

        return activities_df.to_dict("records")

    def get_old_tracks_ids(self):
        try:
            return self.db_connection.execute("SELECT run_id FROM activities").fetchdf()["run_id"].astype(str).tolist()
        except Exception as e:
            self.logger.error(f"Something wrong with get_old_tracks_ids: {str(e)}")
            return []

    def get_old_tracks_dates(self):
        try:
            return (
                self.db_connection.execute(
                    "SELECT start_date_local FROM activities ORDER BY start_date_local DESC"  # noqa: E501
                )
                .fetchdf()["start_date_local"]
                .astype(str)
                .tolist()
            )
        except Exception as e:
            self.logger.error(f"Something wrong with get_old_tracks_dates: {str(e)}")
            return []

    def _get_latest_gps_activity(self):
        """
        get the latest activity with GPS data from Strava API
        Returns: Activity object or None if no GPS activity found
        """
        try:
            activities = list(self.client.get_activities(limit=30))

            if not activities:
                self.logger.info("No activities found from Strava API.")
                return None

            self.logger.info(f"Checking {len(activities)} recent activities for GPS data.")

            # Check each activity for GPS data (latlng stream)
            for activity in activities:
                try:
                    # Get available stream types for this activity
                    stream_types = ["latlng"]
                    streams = self.client.get_activity_streams(activity.id, types=stream_types, resolution="low")

                    # Check if latlng stream exists and has data
                    if streams.get("latlng") and streams["latlng"].data:
                        self.logger.info(
                            f"Found GPS-enabled activity: {activity.name} ({activity.id}) from {activity.start_date}"
                        )
                        return activity

                    # Rate limiting to avoid hitting API limits
                    time.sleep(0.5)

                except Exception as e:
                    self.logger.warning(f"Failed to check streams for activity {activity.id}: {e}")
                    continue

            self.logger.info("No GPS-enabled activities found in recent activities.")
            return None

        except Exception as e:
            self.logger.error(f"Failed to get latest GPS activity: {e}", exc_info=True)
            return None

    def sync_flyby_data(self):
        """
        get the flyby data for the latest GPS activity and store it in the database.
        """
        try:
            self.logger.info("Starting flyby data synchronization...")

            # get the latest GPS activity
            latest_gps_activity = self._get_latest_gps_activity()
            if not latest_gps_activity:
                self.logger.info("No GPS-enabled activities found, skipping flyby sync.")
                return 0

            self.logger.info(
                f"Processing flyby data for activity: {latest_gps_activity.name} ({latest_gps_activity.id})"
            )

            # check if flyby data for this activity already exists
            try:
                existing_count = self.db_connection.execute(
                    "SELECT COUNT(*) FROM activities_flyby WHERE activity_id = ?",
                    [latest_gps_activity.id],
                ).fetchone()

                if existing_count and existing_count[0] > 0:
                    self.logger.info(
                        f"Flyby data for activity {latest_gps_activity.id}"
                        " already exists "
                        f"({existing_count[0]} records), skipping."
                    )
                    return existing_count[0]
            except Exception as e:
                self.logger.warning(f"Could not check existing flyby data: {e}")

            # get the streams for the latest GPS activity
            stream_types = [
                "time",
                "latlng",
                "altitude",
                "heartrate",
                "distance",
                "velocity_smooth",
            ]

            self.logger.info(f"Fetching stream data for activity {latest_gps_activity.id}...")
            streams = self.client.get_activity_streams(latest_gps_activity.id, types=stream_types, resolution="high")

            # check if the essential streams are present
            if not streams.get("time") or not streams.get("latlng"):
                self.logger.warning(
                    f"Activity {latest_gps_activity.id} missing essential streams "
                    "(time/latlng), skipping flyby processing."
                )
                return 0

            self.logger.info(f"Retrieved streams: {list(streams.keys())}for activity {latest_gps_activity.id}")

            flyby_df = convert_streams_to_flyby_dataframe(latest_gps_activity, streams)

            if flyby_df.empty:
                self.logger.warning(f"No flyby data generated for activity {latest_gps_activity.id}")
                return 0

            records_stored = store_flyby_data(self.db_connection, flyby_df)

            if records_stored > 0:
                self.logger.info(
                    f"Successfully synchronized {records_stored} flyby records for activity {latest_gps_activity.id}"
                )
            else:
                self.logger.warning(f"No flyby records were stored for activity {latest_gps_activity.id}")

            return records_stored

        except stravalib.exc.RateLimitExceeded as e:
            self.logger.warning(f"Strava API rate limit exceeded during flyby sync: {e}")
            retry_after = getattr(e, "retry_after", 60)
            self.logger.info(f"Waiting {retry_after} seconds before retrying...")
            time.sleep(retry_after)

            try:
                self.logger.info("Retrying flyby data synchronization after rate limit...")
                return self.sync_flyby_data()
            except Exception as retry_e:
                self.logger.error(f"Retry failed for flyby sync: {retry_e}")
                return 0

        except stravalib.exc.ActivityUploadFailed as e:
            self.logger.error(f"Strava activity access failed during flyby sync: {e}")
            return 0

        except Exception as e:
            self.logger.error(
                f"Unexpected error during flyby data synchronization: {e}",
                exc_info=True,
            )
            return 0

    def sync_and_generate_fit(self, force=False):
        """
        Syncs new activities from Strava and generates FIT files.
        This method only generates FIT files without writing to database tables.
        """
        self.check_access()
        self.logger.info("Starting FIT file generation process.")

        filters = {}
        if not force:
            # Check existing FIT files instead of database records
            try:
                existing_fit_files = set()
                if os.path.exists("FIT_OUT"):
                    existing_fit_files = {f.replace(".fit", "") for f in os.listdir("FIT_OUT") if f.endswith(".fit")}

                if existing_fit_files:
                    self.logger.info(
                        f"Found {len(existing_fit_files)} existing FIT files. "
                        "Will skip activities that already have FIT files."
                    )
                else:
                    self.logger.info("No existing FIT files found. Processing all activities.")
            except Exception:
                self.logger.warning("Could not check existing FIT files, processing all activities. Error: {e}")
                existing_fit_files = set()

        activities = list(self.client.get_activities(**filters))
        if not activities:
            self.logger.info("No activities found to generate FIT files for.")
            return []

        self.logger.info(f"Found {len(activities)} activities for FIT processing.")
        fit_files_generated = []
        for activity in activities:
            try:
                # Check if FIT file already exists (instead of checking database)
                if not force and str(activity.id) in existing_fit_files:
                    self.logger.info(f"Skipping activity {activity.id}, FIT file already exists.")
                    continue

                self.logger.info(f"Processing activity for FIT: {activity.id} ({activity.name})")
                stream_types = [
                    "time",
                    "latlng",
                    "altitude",
                    "heartrate",
                    "cadence",
                    "velocity_smooth",
                    "distance",
                ]
                streams = self.client.get_activity_streams(activity.id, types=stream_types, resolution="high")

                # Generate FIT data without writing to database
                dataframes = get_dataframes_for_fit_tables(activity, streams)
                fit_byte_data = self.build_fit_file_from_dataframes(dataframes)

                filename = f"{activity.id}.fit"
                filepath = os.path.join("FIT_OUT", filename)
                with open(filepath, "wb") as f:
                    f.write(fit_byte_data)
                fit_files_generated.append(filename)
                self.logger.info(f"Successfully generated FIT file: {filepath}")

            except Exception as e:
                self.logger.error(
                    f"Failed to generate FIT file for activity {activity.id}: {e}",
                    exc_info=True,
                )
        return fit_files_generated

    def build_fit_file_from_dataframes(self, dataframes):
        """
        Builds a FIT file from a dictionary of DataFrames,
        following the official example's logic.
        """
        builder = FitFileBuilder(auto_define=True)

        # The order of messages is important.
        self._add_file_id_mesg(builder, dataframes.get("fit_file_id"))
        self._add_event_mesg(builder, dataframes, event_type="start")
        self._add_record_mesgs(builder, dataframes.get("fit_record"))
        self._add_lap_mesg(builder, dataframes.get("fit_lap"))
        self._add_session_mesg(builder, dataframes.get("fit_session"))
        self._add_event_mesg(builder, dataframes, event_type="stop")

        return builder.build().to_bytes()

    def _add_file_id_mesg(self, builder, df):
        if df is None or df.empty:
            return
        msg = FileIdMessage()
        row = df.iloc[0]
        msg.type = FileType(row["type"])
        msg.manufacturer = row["manufacturer"]
        msg.product = row["product"]
        msg.software_version = row["software_version"]
        msg.serial_number = random.randint(0, 4294967295)
        naive_dt = row["time_created"].tz_localize(None)
        msg.time_created = round(naive_dt.timestamp() * 1000)
        builder.add(msg)

    def _add_event_mesg(self, builder, dataframes, event_type):
        if event_type == "start":
            timestamp = dataframes["fit_session"].iloc[0]["start_time"]
            event_type_enum = EventType.START
        else:  # stop
            timestamp = dataframes["fit_session"].iloc[0]["timestamp"]
            event_type_enum = EventType.STOP_ALL

        naive_dt = timestamp.tz_localize(None)
        timestamp_ms = round(naive_dt.timestamp() * 1000)

        event_msg = EventMessage()
        event_msg.event = Event.TIMER
        event_msg.event_type = event_type_enum
        event_msg.timestamp = timestamp_ms
        builder.add(event_msg)

    def _add_record_mesgs(self, builder, df):
        if df is None or df.empty:
            return
        for _, row in df.iterrows():
            msg = RecordMessage()
            naive_ts = row["timestamp"].tz_localize(None)
            msg.timestamp = round(naive_ts.timestamp() * 1000)

            if pd.notna(row["position_lat"]):
                msg.position_lat = row["position_lat"]
            if pd.notna(row["position_long"]):
                msg.position_long = row["position_long"]
            if pd.notna(row["distance"]):
                msg.distance = row["distance"]
            if pd.notna(row["altitude"]):
                msg.altitude = row["altitude"]
            if pd.notna(row["speed"]):
                msg.speed = row["speed"]
            if pd.notna(row["heart_rate"]):
                msg.heart_rate = row["heart_rate"]
            if pd.notna(row["cadence"]):
                msg.cadence = row["cadence"]
            builder.add(msg)

    def _add_lap_mesg(self, builder, df):
        if df is None or df.empty:
            return
        msg = LapMessage()
        row = df.iloc[0]

        naive_ts = row["timestamp"].tz_localize(None)
        msg.timestamp = round(naive_ts.timestamp() * 1000)

        naive_start = row["start_time"].tz_localize(None)
        msg.start_time = round(naive_start.timestamp() * 1000)

        msg.total_elapsed_time = row["total_elapsed_time"] * 1000
        msg.total_timer_time = row["total_timer_time"] * 1000
        msg.total_distance = row["total_distance"]
        if pd.notna(row["avg_speed"]):
            msg.avg_speed = row["avg_speed"]
        if pd.notna(row["avg_heart_rate"]):
            msg.avg_heart_rate = row["avg_heart_rate"]
        if pd.notna(row["avg_cadence"]):
            msg.avg_cadence = row["avg_cadence"]
        builder.add(msg)

    def _add_session_mesg(self, builder, df):
        if df is None or df.empty:
            return
        msg = SessionMessage()
        row = df.iloc[0]

        naive_ts = row["timestamp"].tz_localize(None)
        msg.timestamp = round(naive_ts.timestamp() * 1000)

        naive_start = row["start_time"].tz_localize(None)
        msg.start_time = round(naive_start.timestamp() * 1000)

        msg.total_elapsed_time = row["total_elapsed_time"] * 1000
        msg.total_timer_time = row["total_timer_time"] * 1000
        msg.total_distance = row["total_distance"]
        msg.sport = row["sport"]
        if pd.notna(row["avg_speed"]):
            msg.avg_speed = row["avg_speed"]
        if pd.notna(row["avg_heart_rate"]):
            msg.avg_heart_rate = row["avg_heart_rate"]
        if pd.notna(row["avg_cadence"]):
            msg.avg_cadence = row["avg_cadence"]
        builder.add(msg)

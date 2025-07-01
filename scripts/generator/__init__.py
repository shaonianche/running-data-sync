import datetime
import os
import ssl
import time
from xml.dom import minidom
from xml.etree.ElementTree import Element, SubElement, tostring

import arrow
import certifi
import geopy
import pandas as pd
import stravalib
from geopy.geocoders import Nominatim
from gpxtrackposter import track_loader
from polyline_processor import filter_out

from .db import (
    get_dataframe_from_strava_activities,
    init_db,
    update_or_create_activities,
)

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
        print("Access ok")

    def sync(self, force):
        """
        Sync activities from Strava to the local DuckDB database.
        """
        self.check_access()

        print("Start syncing")
        if force:
            filters = {"before": datetime.datetime.now(datetime.timezone.utc)}
        else:
            # Use a raw SQL query to get the last activity's start_date
            last_activity_date_result = self.db_connection.execute(
                "SELECT MAX(start_date) FROM activities"
            ).fetchone()
            last_activity_date = (
                last_activity_date_result[0] if last_activity_date_result else None
            )

            if last_activity_date:
                # The date from DB is timezone-aware, so we can parse it directly.
                last_activity_date = arrow.get(last_activity_date).datetime
                filters = {"after": last_activity_date}
            else:
                filters = {"before": datetime.datetime.now(datetime.timezone.utc)}

        strava_activities = list(self.client.get_activities(**filters))
        print(f"Found {len(strava_activities)} new activities from Strava.")

        if not strava_activities:
            print("No new activities to sync.")
            return

        # Convert to DataFrame and upsert
        activities_df = get_dataframe_from_strava_activities(strava_activities)
        updated_count = update_or_create_activities(self.db_connection, activities_df)
        print(f"Synced {updated_count} activities to the database.")

    def _make_tcx_from_streams(self, activity, streams):
        # TCX XML structure
        root = Element("TrainingCenterDatabase")
        root.attrib = {
            "xmlns": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2",
            "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
            "xsi:schemaLocation": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd",
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
            avg_hr_val.text = str(
                int(
                    sum(s for s in streams["heartrate"].data)
                    / len(streams["heartrate"].data)
                )
            )

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
        alt_stream = (
            streams.get("altitude").data
            if streams.get("altitude")
            else [0] * len(time_stream)
        )
        hr_stream = (
            streams.get("heartrate").data
            if streams.get("heartrate")
            else [0] * len(time_stream)
        )

        for i, time_offset in enumerate(time_stream):
            trackpoint_node = SubElement(track_node, "Trackpoint")

            time_node = SubElement(trackpoint_node, "Time")
            time_node.text = (
                activity.start_date + datetime.timedelta(seconds=time_offset)
            ).isoformat()

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

        print("Fetching all activities from Strava to check for missing TCX files...")
        activities = self.client.get_activities()  # Fetch all activities

        tcx_files = []

        activities_to_process = [
            a for a in activities if str(a.id) not in downloaded_ids
        ]

        print(f"Found {len(activities_to_process)} new activities to generate TCX for.")

        for activity in activities_to_process:
            try:
                print(f"Processing activity: {activity.name} ({activity.id})")
                stream_types = ["time", "latlng", "altitude", "heartrate"]
                streams = self.client.get_activity_streams(
                    activity.id, types=stream_types
                )

                if not streams.get("latlng") or not streams.get("time"):
                    print(
                        f"Skipping activity {activity.id} due to missing latlng or time streams."
                    )
                    continue

                tcx_content = self._make_tcx_from_streams(activity, streams)
                filename = f"{activity.id}.tcx"
                tcx_files.append((filename, tcx_content))

                # Rate limiting
                time.sleep(2)
            except Exception as e:
                print(f"Failed to process activity {activity.id}: {e}")

        return tcx_files

    def sync_from_data_dir(self, data_dir, file_suffix="gpx", activity_title_dict={}):
        loader = track_loader.TrackLoader()
        tracks = loader.load_tracks(
            data_dir,
            file_suffix=file_suffix,
            activity_title_dict=activity_title_dict,
        )
        print(f"Found {len(tracks)} tracks from {data_dir}.")
        if not tracks:
            return

        self.sync_from_app(tracks)

    def sync_from_app(self, app_tracks):
        if not app_tracks:
            print("No tracks to sync from app.")
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
                "start_date": datetime.datetime.strptime(
                    track_data["start_date"], "%Y-%m-%d %H:%M:%S"
                ),
                "start_date_local": datetime.datetime.strptime(
                    track_data["start_date_local"], "%Y-%m-%d %H:%M:%S"
                ),
                "location_country": "",  # GPX/FIT files don't have this
                "summary_polyline": track_data["map"].summary_polyline,
                "average_heartrate": track_data["average_heartrate"],
                "average_speed": track_data["average_speed"],
                "elevation_gain": track_data["elevation_gain"],
            }
            activities_data.append(record)

        activities_df = pd.DataFrame(activities_data)
        updated_count = update_or_create_activities(self.db_connection, activities_df)
        print(f"Synced {updated_count} activities to the database.")

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
        activities_df["start_date_local_date"] = pd.to_datetime(
            activities_df["start_date_local"]
        ).dt.date
        activities_df = activities_df.sort_values("start_date_local_date")
        # Get the difference in days between consecutive runs
        activities_df["date_diff"] = (
            activities_df["start_date_local_date"].diff().dt.days
        )
        # Identify the start of a new streak
        activities_df["new_streak"] = (activities_df["date_diff"] != 1).cumsum()
        # Calculate streak number within each group
        activities_df["streak"] = activities_df.groupby("new_streak").cumcount() + 1

        # Drop temporary columns
        activities_df = activities_df.drop(
            columns=["start_date_local_date", "date_diff", "new_streak"]
        )

        # Polyline filtering
        if not IGNORE_BEFORE_SAVING:
            activities_df["summary_polyline"] = activities_df["summary_polyline"].apply(
                filter_out
            )

        return activities_df.to_dict("records")

    def get_old_tracks_ids(self):
        try:
            return (
                self.db_connection.execute("SELECT run_id FROM activities")
                .fetchdf()["run_id"]
                .astype(str)
                .tolist()
            )
        except Exception as e:
            print(f"Something wrong with get_old_tracks_ids: {str(e)}")
            return []

    def get_old_tracks_dates(self):
        try:
            return (
                self.db_connection.execute(
                    "SELECT start_date_local FROM activities ORDER BY start_date_local DESC"
                )
                .fetchdf()["start_date_local"]
                .astype(str)
                .tolist()
            )
        except Exception as e:
            print(f"Something wrong with get_old_tracks_dates: {str(e)}")
            return []

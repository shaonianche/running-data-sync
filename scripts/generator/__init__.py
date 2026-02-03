import datetime
import os
import sys

import arrow
import stravalib
from gpxtrackposter import track_loader
from sqlalchemy import func

from polyline_processor import filter_out

from .db import Activity, init_db, update_or_create_activity

from synced_data_file_logger import save_synced_data_file_list

IGNORE_BEFORE_SAVING = os.getenv("IGNORE_BEFORE_SAVING", False)


class Generator:
    def __init__(self, db_path):
        self.client = stravalib.Client()
        self.session = init_db(db_path)

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
        Sync activities means sync from strava
        TODO, better name later
        """
        self.check_access()

        print("Start syncing")
        if force:
            filters = {"before": datetime.datetime.now(datetime.timezone.utc)}
        else:
            last_activity = self.session.query(func.max(Activity.start_date)).scalar()
            if last_activity:
                last_activity_date = arrow.get(last_activity)
                last_activity_date = last_activity_date.shift(days=-7)
                filters = {"after": last_activity_date.datetime}
            else:
                filters = {"before": datetime.datetime.now(datetime.timezone.utc)}

        for activity in self.client.get_activities(**filters):
            if self.only_run and activity.type != "Run":
                continue
            if IGNORE_BEFORE_SAVING:
                if activity.map and activity.map.summary_polyline:
                    activity.map.summary_polyline = filter_out(
                        activity.map.summary_polyline
                    )
            #  strava use total_elevation_gain as elevation_gain
            activity.elevation_gain = activity.total_elevation_gain
            activity.subtype = activity.type
            created = update_or_create_activity(self.session, activity)
            if created:
                sys.stdout.write("+")
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
            data_dir, file_suffix=file_suffix, activity_title_dict=activity_title_dict
        )
        print(f"load {len(tracks)} tracks")
        if not tracks:
            print("No tracks found.")
            return

        synced_files = []

        for t in tracks:
            created = update_or_create_activity(
                self.session, t.to_namedtuple(run_from=file_suffix)
            )
            if created:
                sys.stdout.write("+")
            else:
                sys.stdout.write(".")
            synced_files.extend(t.file_names)
            sys.stdout.flush()

        save_synced_data_file_list(synced_files)

        self.session.commit()

    def sync_from_app(self, app_tracks):
        if not app_tracks:
            print("No tracks found.")
            return
        print("Syncing tracks '+' means new track '.' means update tracks")
        synced_files = []
        for t in app_tracks:
            created = update_or_create_activity(self.session, t)
            if created:
                sys.stdout.write("+")
            else:
                sys.stdout.write(".")
            if "file_names" in t:
                synced_files.extend(t.file_names)
            sys.stdout.flush()

        self.session.commit()

    def load(self):
        # if sub_type is not in the db, just add an empty string to it
        query = self.session.query(Activity).filter(Activity.distance > 0.1)
        if self.only_run:
            query = query.filter(Activity.type == "Run")

        activities = query.order_by(Activity.start_date_local)
        activity_list = []

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
            activities = self.session.query(Activity).all()
            return [str(a.run_id) for a in activities]
        except Exception as e:
            # pass the error
            print(f"something wrong with {str(e)}")
            return []

    def get_old_tracks_dates(self):
        try:
            activities = (
                self.session.query(Activity)
                .order_by(Activity.start_date_local.desc())
                .all()
            )
            return [str(a.start_date_local) for a in activities]
        except Exception as e:
            # pass the error
            print(f"something wrong with {str(e)}")
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

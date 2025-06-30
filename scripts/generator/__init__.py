import datetime
import os
import ssl
import sys
import time
from xml.dom import minidom
from xml.etree.ElementTree import Element, SubElement, tostring

import arrow
import certifi
import geopy
import stravalib
from geopy.geocoders import Nominatim
from gpxtrackposter import track_loader
from polyline_processor import filter_out
from sqlalchemy import func
from synced_data_file_logger import save_synced_data_file_list

from .db import Activity, init_db, update_or_create_activity

IGNORE_BEFORE_SAVING = os.getenv("IGNORE_BEFORE_SAVING", False)


geopy.geocoders.options.default_user_agent = "running-data-sync"
# reverse the location (lat, lon) -> location detail
ctx = ssl.create_default_context(cafile=certifi.where())
geopy.geocoders.options.default_ssl_context = ctx
g = Nominatim(user_agent="running-data-sync", timeout=10)


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

        activities = list(self.client.get_activities(**filters))
        print(f"Syncing {len(activities)} activities")

        for activity in activities:
            if self.only_run and activity.type != "Run":
                continue
            if IGNORE_BEFORE_SAVING:
                if activity.map and activity.map.summary_polyline:
                    activity.map.summary_polyline = filter_out(
                        activity.map.summary_polyline
                    )
            activity.subtype = activity.type
            created = update_or_create_activity(self.session, activity)
            if created:
                sys.stdout.write("+")
            else:
                sys.stdout.write(".")
            sys.stdout.flush()
        self.session.commit()

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
        activities = self.session.query(Activity).order_by(Activity.start_date_local)
        activity_list = []

        streak = 0
        last_date = None
        for activity in activities:
            if self.only_run and activity.type != "Run":
                continue
            # Determine running streak.
            date = datetime.datetime.strptime(
                activity.start_date_local, "%Y-%m-%d %H:%M:%S"
            ).date()
            if last_date is None:
                streak = 1
            elif date == last_date:
                pass
            elif date == last_date + datetime.timedelta(days=1):
                streak += 1
            else:
                assert date > last_date
                streak = 1
            activity.streak = streak
            last_date = date
            if not IGNORE_BEFORE_SAVING:
                activity.summary_polyline = filter_out(activity.summary_polyline)
            activity_list.append(activity.to_dict())

        return activity_list

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

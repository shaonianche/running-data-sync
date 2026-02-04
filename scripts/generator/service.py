"""Generator service - core coordinator for activity synchronization."""

import datetime
import os
import random
import ssl

import certifi
import geopy
import pandas as pd
import stravalib
from geopy.geocoders import Nominatim
from ..gpxtrackposter import track_loader
from ..polyline_processor import filter_out

from ..utils import get_logger

from .db import (
    get_db_connection,
    init_db,
    update_or_create_activities,
)
from .fit_builder import FitBuilderMixin
from .strava_client import StravaClientMixin
from .tcx_builder import TcxBuilderMixin

IGNORE_BEFORE_SAVING = os.getenv("IGNORE_BEFORE_SAVING", False)


geopy.geocoders.options.default_user_agent = "running-data-sync"
# reverse the location (lat, lon) -> location detail
ctx = ssl.create_default_context(cafile=certifi.where())
geopy.geocoders.options.default_ssl_context = ctx
g = Nominatim(user_agent="running-data-sync", timeout=10)


class Generator(FitBuilderMixin, TcxBuilderMixin, StravaClientMixin):
    def __init__(self, db_path):
        self.client = stravalib.Client()
        # Lazy-init DB to avoid unnecessary writes; hold path and connect only when needed
        self.db_path = db_path
        self.db_connection = None
        self.logger = get_logger(self.__class__.__name__)

        self.client_id = ""
        self.client_secret = ""
        self.refresh_token = ""
        self.only_run = False
        self.serial_number = random.randint(0, 4294967295)  # Consistent serial per instance

    def set_strava_config(self, client_id, client_secret, refresh_token):
        self.client_id = client_id
        self.client_secret = client_secret
        self.refresh_token = refresh_token

    def sync_from_data_dir(self, data_dir, file_suffix="gpx", activity_title_dict=None):
        activity_title_dict = activity_title_dict if activity_title_dict is not None else {}
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

        # Initialize DB connection if not already done
        if self.db_connection is None:
            self.db_connection = init_db(self.db_path)

        activities_df = pd.DataFrame(activities_data)
        updated_count = update_or_create_activities(self.db_connection, activities_df)
        self.logger.info(f"Synced {updated_count} activities to the database.")

    def load(self):
        """
        Loads activities from the database and calculates the running streak.
        """
        query = "SELECT * FROM activities ORDER BY start_date_local"
        # Use existing writable connection if available, otherwise open a read-only one
        if self.db_connection is not None:
            activities_df = self.db_connection.execute(query).fetchdf()
        else:
            try:
                ro_con = get_db_connection(database=self.db_path, read_only=True)
                activities_df = ro_con.execute(query).fetchdf()
                ro_con.close()
            except FileNotFoundError:
                self.logger.info("Database file not found, returning empty list.")
                return []
            except Exception as e:
                self.logger.warning(f"Failed to load activities from database: {e}")
                return []

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

        # Replace NaN/NaT with None for JSON compatibility
        activities_df = activities_df.where(pd.notna(activities_df), None)

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

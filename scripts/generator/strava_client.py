"""Strava API interaction utilities."""

import datetime
import os
import time

import arrow
import stravalib

from ..config import FIT_FOLDER
from ..exceptions import FlybySyncError
from .db import (
    convert_streams_to_flyby_dataframe,
    enqueue_flyby_activities,
    get_dataframe_from_strava_activities,
    get_dataframes_for_fit_tables,
    get_db_connection,
    init_db,
    list_pending_flyby_activities,
    mark_flyby_activity_done,
    prune_activities_not_in_remote_ids,
    store_flyby_data,
    update_flyby_activity_error,
    update_or_create_activities,
)

FLYBY_REQUEST_SLEEP_SECONDS = float(os.getenv("STRAVA_FLYBY_REQUEST_SLEEP", "0.5"))
FLYBY_MAX_RETRIES = int(os.getenv("STRAVA_FLYBY_MAX_RETRIES", "3"))


class StravaClientMixin:
    """Mixin class providing Strava API interaction methods for Generator."""

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

    def sync(self, force, prune=False):
        """
        Sync activities from Strava to the local DuckDB database.
        """
        self.check_access()

        self.logger.info("Starting Strava DB sync. force=%s prune=%s", force, prune)
        if force:
            filters = {"before": datetime.datetime.now(datetime.timezone.utc)}
        else:
            # Use a read-only connection to avoid writes when probing state
            last_activity_date = None
            try:
                ro_con = get_db_connection(database=self.db_path, read_only=True)
                last_activity_date_result = ro_con.execute("SELECT MAX(start_date) FROM activities").fetchone()
                ro_con.close()
                last_activity_date = last_activity_date_result[0] if last_activity_date_result else None
            except Exception:
                # Table may not exist yet; treat as no data
                last_activity_date = None

            if last_activity_date:
                last_activity_date = arrow.get(last_activity_date).datetime
                filters = {"after": last_activity_date}
            else:
                filters = {"before": datetime.datetime.now(datetime.timezone.utc)}

        strava_activities = list(self.client.get_activities(**filters))

        # Filter out activities that already exist in DB by run_id using read-only connection
        try:
            ro_con = get_db_connection(database=self.db_path, read_only=True)
            try:
                existing_ids_df = ro_con.execute("SELECT run_id FROM activities").fetchdf()
                existing_ids = set(existing_ids_df["run_id"].astype(str).tolist())
            except Exception:
                existing_ids = set()
            finally:
                ro_con.close()
        except Exception:
            existing_ids = set()
        activities_to_process = [a for a in strava_activities if str(a.id) not in existing_ids]

        self.logger.info(f"Found {len(activities_to_process)} new activities from Strava.")

        # Initialize DB (writable) when we have data to write or pending flyby queue to process
        if self.db_connection is None:
            self.db_connection = init_db(self.db_path)

        if prune:
            # Prune requires a full remote ID snapshot, independent of incremental sync window.
            all_remote_ids = {int(a.id) for a in self.client.get_activities()}
            pruned = prune_activities_not_in_remote_ids(self.db_connection, all_remote_ids)
            if pruned > 0:
                self.logger.info("Pruned %d local activities missing on Strava.", pruned)
            else:
                self.logger.info("Prune completed. No stale local activities found.")

        if not activities_to_process:
            self.logger.info("No new activities to sync.")
            # Continue to process any pending flyby queue entries.
        else:
            # Convert to DataFrame and upsert only truly new activities
            activities_df = get_dataframe_from_strava_activities(activities_to_process)
            updated_count = update_or_create_activities(self.db_connection, activities_df)
            self.logger.info(f"Synced {updated_count} activities to the database.")

            # Enqueue newly synced activities for flyby processing
            enqueue_flyby_activities(self.db_connection, [int(a.id) for a in activities_to_process])
        self.logger.info("Starting flyby data synchronization for queued activities...")
        pending_ids = list_pending_flyby_activities(self.db_connection)
        if not pending_ids:
            self.logger.info("No flyby data available to sync for new activities.")
            return

        activity_map = {int(a.id): a for a in activities_to_process}
        total_flyby_records = 0

        for activity_id in pending_ids:
            activity = activity_map.get(int(activity_id))
            if activity is None:
                try:
                    if FLYBY_REQUEST_SLEEP_SECONDS > 0:
                        time.sleep(FLYBY_REQUEST_SLEEP_SECONDS)
                    activity = self.client.get_activity(activity_id)
                except stravalib.exc.RateLimitExceeded as e:
                    retry_after = getattr(e, "retry_after", None)
                    wait = retry_after if retry_after else 60
                    update_flyby_activity_error(
                        self.db_connection,
                        int(activity_id),
                        "rate_limited",
                        str(e),
                    )
                    self.logger.warning(
                        f"Rate limit exceeded while fetching activity {activity_id}. "
                        f"Waiting {wait} seconds and stopping flyby sync."
                    )
                    time.sleep(wait)
                    return
                except Exception as e:
                    update_flyby_activity_error(
                        self.db_connection,
                        int(activity_id),
                        "error",
                        str(e),
                    )
                    self.logger.warning(f"Failed to fetch activity {activity_id}: {e}. Keeping it queued.")
                    continue

            for attempt in range(FLYBY_MAX_RETRIES):
                try:
                    if FLYBY_REQUEST_SLEEP_SECONDS > 0:
                        time.sleep(FLYBY_REQUEST_SLEEP_SECONDS)
                    records = self._sync_flyby_for_activity(activity)
                    total_flyby_records += records
                    mark_flyby_activity_done(self.db_connection, int(activity.id))
                    break
                except stravalib.exc.RateLimitExceeded as e:
                    retry_after = getattr(e, "retry_after", None)
                    wait = retry_after if retry_after else min(60 * (2**attempt), 900)
                    update_flyby_activity_error(
                        self.db_connection,
                        int(activity.id),
                        "rate_limited",
                        str(e),
                    )
                    self.logger.warning(
                        f"Rate limit exceeded while syncing flyby for activity {activity.id}. "
                        f"Waiting {wait} seconds (attempt {attempt + 1}/{FLYBY_MAX_RETRIES})."
                    )
                    time.sleep(wait)
                    if attempt == FLYBY_MAX_RETRIES - 1:
                        self.logger.warning(f"Rate limit persists. Leaving activity {activity.id} in the queue.")
                        return
                except FlybySyncError as activity_error:
                    update_flyby_activity_error(
                        self.db_connection,
                        int(activity.id),
                        "error",
                        str(activity_error),
                    )
                    self.logger.warning(
                        f"Flyby sync failed for activity {activity.id}: {activity_error}. Keeping it queued."
                    )
                    break
                except Exception as activity_error:
                    update_flyby_activity_error(
                        self.db_connection,
                        int(activity.id),
                        "error",
                        str(activity_error),
                    )
                    self.logger.warning(
                        f"Unexpected flyby sync failure for activity {activity.id}: {activity_error}. "
                        "Keeping it queued."
                    )
                    break

        if total_flyby_records > 0:
            self.logger.info(f"Successfully synced {total_flyby_records} flyby records.")
        else:
            self.logger.info("No flyby data available to sync for queued activities.")

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
        self.logger.info("Starting flyby data synchronization...")
        retry_count = 0

        while retry_count <= FLYBY_MAX_RETRIES:
            try:
                latest_gps_activity = self._get_latest_gps_activity()
                if not latest_gps_activity:
                    self.logger.info("No GPS-enabled activities found, skipping flyby sync.")
                    return 0

                return self._sync_flyby_for_activity(latest_gps_activity)
            except stravalib.exc.RateLimitExceeded as e:
                retry_count += 1
                if retry_count > FLYBY_MAX_RETRIES:
                    self.logger.error(
                        "Flyby sync failed due to repeated rate limiting after %d retries.",
                        FLYBY_MAX_RETRIES,
                    )
                    return 0

                retry_after = getattr(e, "retry_after", 60)
                self.logger.warning(f"Strava API rate limit exceeded during flyby sync: {e}")
                self.logger.info(
                    "Waiting %s seconds before retrying flyby sync (%d/%d)...",
                    retry_after,
                    retry_count,
                    FLYBY_MAX_RETRIES,
                )
                time.sleep(retry_after)
            except Exception as e:
                self.logger.error(
                    f"Unexpected error during flyby data synchronization: {e}",
                    exc_info=True,
                )
                return 0

    def _sync_flyby_for_activity(self, activity, force=False):
        """
        Internal method to sync streams (flyby data) for a specific activity object.
        """
        try:
            self.logger.info(f"Processing flyby data for activity: {activity.name} ({activity.id})")

            # check if flyby data for this activity already exists
            if not force:
                try:
                    existing_count = self.db_connection.execute(
                        "SELECT COUNT(*) FROM activities_flyby WHERE activity_id = ?",
                        [activity.id],
                    ).fetchone()

                    if existing_count and existing_count[0] > 0:
                        self.logger.info(
                            f"Flyby data for activity {activity.id}"
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
                "cadence",
                "watts",
            ]

            self.logger.info(f"Fetching stream data for activity {activity.id}...")
            streams = self.client.get_activity_streams(activity.id, types=stream_types, resolution="high")

            # Check if the essential streams are present.
            # For indoor activities, latlng might be missing, but we need at least time.
            time_stream = streams.get("time")
            if not time_stream or not time_stream.data:
                self.logger.warning(f"Activity {activity.id} missing time stream, skipping flyby processing.")
                return 0

            # Require at least one meaningful data stream beyond time to avoid writing empty flyby rows.
            meaningful_streams = [
                "latlng",
                "distance",
                "velocity_smooth",
                "altitude",
                "heartrate",
                "cadence",
                "watts",
            ]
            has_meaningful_stream = any(
                streams.get(name) and getattr(streams.get(name), "data", None) for name in meaningful_streams
            )
            if not has_meaningful_stream:
                self.logger.info(
                    f"Activity {activity.id} has no meaningful stream data, skipping flyby processing."
                )
                return 0

            # If latlng is missing, we can still proceed for indoor activities.
            if not streams.get("latlng"):
                self.logger.info(
                    f"Activity {activity.id} missing latlng stream. Proceeding as indoor/stationary activity."
                )

            self.logger.info(f"Retrieved streams: {list(streams.keys())}for activity {activity.id}")

            flyby_df = convert_streams_to_flyby_dataframe(activity, streams)

            if "cadence" not in streams:
                self.logger.warning(
                    f"Activity {activity.id} does not have 'cadence' stream. Stride Length cannot be calculated."
                )

            if flyby_df.empty:
                self.logger.warning(f"No flyby data generated for activity {activity.id}")
                return 0

            records_stored = store_flyby_data(self.db_connection, flyby_df)

            if records_stored > 0:
                self.logger.info(f"Successfully synchronized {records_stored} flyby records for activity {activity.id}")
            else:
                self.logger.warning(f"No flyby records were stored for activity {activity.id}")

            return records_stored

        except stravalib.exc.RateLimitExceeded:
            # Re-raise for caller-level retry and queue persistence.
            raise
        except stravalib.exc.ActivityUploadFailed as e:
            raise FlybySyncError(f"Strava activity access failed during flyby sync: {e}") from e
        except Exception as e:
            raise FlybySyncError(f"Unexpected flyby sync error for {activity.id}: {e}") from e

    def sync_specific_activity(self, activity_id, force=False):
        """
        Sync a specific activity by ID, including its flyby data.
        """
        self.check_access()
        self.logger.info(f"Syncing specific activity ID: {activity_id}")

        try:
            activity = self.client.get_activity(activity_id)
        except Exception as e:
            self.logger.error(f"Failed to fetch activity {activity_id} from Strava: {e}")
            return

        # Initialize DB (writable)
        if self.db_connection is None:
            self.db_connection = init_db(self.db_path)

        # Sync Activity Summary
        activities_df = get_dataframe_from_strava_activities([activity])
        update_or_create_activities(self.db_connection, activities_df)
        self.logger.info(f"Synced summary for activity {activity_id}.")

        # Sync Flyby
        try:
            self._sync_flyby_for_activity(activity, force=force)
        except stravalib.exc.RateLimitExceeded as e:
            self.logger.warning(f"Rate limit exceeded while syncing activity {activity_id}: {e}")
            # We could retry here, but for single activity maybe just fail is okay or wait
            time.sleep(60)
            self._sync_flyby_for_activity(activity, force=force)

    def sync_and_generate_fit(self, force=False):
        """
        Syncs new activities from Strava and generates FIT files.
        This method only generates FIT files without writing to database tables.
        """
        self.check_access()
        self.logger.info("Starting FIT file generation process.")

        filters = {}
        if not force:
            existing_fit_files = set()
            # Check existing FIT files instead of database records
            try:
                if FIT_FOLDER.exists():
                    existing_fit_files = {f.stem for f in FIT_FOLDER.iterdir() if f.is_file() and f.suffix == ".fit"}

                if existing_fit_files:
                    self.logger.info(
                        f"Found {len(existing_fit_files)} existing FIT files. "
                        "Will skip activities that already have FIT files."
                    )
                else:
                    self.logger.info("No existing FIT files found. Processing all activities.")
            except Exception as e:
                self.logger.warning(f"Could not check existing FIT files, processing all activities. Error: {e}")
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
                FIT_FOLDER.mkdir(parents=True, exist_ok=True)
                filepath = FIT_FOLDER / filename
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

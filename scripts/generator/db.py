import concurrent.futures
import datetime
import ssl
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import certifi
import duckdb
import geopy
import pandas as pd
from ..exceptions import StorageError
from fit_tool.profile.profile_type import Sport, SubSport
from geopy.geocoders import Nominatim

from ..utils import get_logger, load_env_config

logger = get_logger(__name__)

_geocoder = None


def get_geocoder():
    """Lazy initialization of geocoder, only created when needed."""
    global _geocoder
    if _geocoder is None:
        geopy.geocoders.options.default_user_agent = "running-data-sync"
        ctx = ssl.create_default_context(cafile=certifi.where())
        geopy.geocoders.options.default_ssl_context = ctx
        _geocoder = Nominatim(user_agent="running-data-sync", timeout=10)
    return _geocoder


@contextmanager
def transaction(con: duckdb.DuckDBPyConnection) -> Iterator[duckdb.DuckDBPyConnection]:
    """
    Context manager for database transactions.
    Autocommits if successful, rolls back on exception.
    """
    con.execute("BEGIN TRANSACTION")
    try:
        yield con
        con.execute("COMMIT")
    except Exception as e:
        con.execute("ROLLBACK")
        raise e


# Canonical schema for the activities table. This is the single source of truth.
ACTIVITIES_SCHEMA = {
    "run_id": "BIGINT PRIMARY KEY",
    "name": "VARCHAR",
    "distance": "DOUBLE",
    "moving_time": "BIGINT",
    "elapsed_time": "BIGINT",
    "type": "VARCHAR",
    "subtype": "VARCHAR",
    "start_date": "TIMESTAMP",
    "start_date_local": "TIMESTAMP",
    "location_country": "VARCHAR",
    "summary_polyline": "VARCHAR",
    "average_heartrate": "DOUBLE",
    "average_speed": "DOUBLE",
    "elevation_gain": "DOUBLE",
}

# Schema for the activities_flyby table
ACTIVITIES_FLYBY_SCHEMA = {
    "activity_id": "BIGINT NOT NULL",
    "time_offset": "INTEGER NOT NULL",
    "lat": "DECIMAL(9, 6)",
    "lng": "DECIMAL(9, 6)",
    "alt": "SMALLINT",
    "pace": "DECIMAL(5, 2) NOT NULL DEFAULT 0.0",
    "hr": "SMALLINT",
    "distance": "INTEGER",
    "cadence": "SMALLINT",
    "watts": "SMALLINT",
}

FIT_FILE_ID_SCHEMA = {
    "serial_number": "VARCHAR PRIMARY KEY",
    "time_created": "TIMESTAMP",
    "manufacturer": "INTEGER",
    "product": "INTEGER",
    "software_version": "DOUBLE",
    "type": "INTEGER",
}

FIT_RECORD_SCHEMA = {
    "activity_id": "BIGINT",
    "timestamp": "TIMESTAMP",
    "position_lat": "DOUBLE",
    "position_long": "DOUBLE",
    "distance": "DOUBLE",
    "altitude": "DOUBLE",
    "speed": "DOUBLE",
    "heart_rate": "INTEGER",
    "cadence": "INTEGER",
}

FIT_LAP_SCHEMA = {
    "activity_id": "BIGINT",
    "timestamp": "TIMESTAMP",
    "start_time": "TIMESTAMP",
    "total_elapsed_time": "DOUBLE",
    "total_timer_time": "DOUBLE",
    "total_distance": "DOUBLE",
    "avg_speed": "DOUBLE",
    "avg_heart_rate": "INTEGER",
    "avg_cadence": "INTEGER",
}

FIT_SESSION_SCHEMA = {
    "activity_id": "BIGINT PRIMARY KEY",
    "timestamp": "TIMESTAMP",
    "start_time": "TIMESTAMP",
    "total_elapsed_time": "DOUBLE",
    "total_timer_time": "DOUBLE",
    "total_distance": "DOUBLE",
    "avg_speed": "DOUBLE",
    "avg_heart_rate": "INTEGER",
    "avg_cadence": "INTEGER",
    "sport": "INTEGER",
}

FLYBY_QUEUE_SCHEMA = {
    "activity_id": "BIGINT PRIMARY KEY",
    "status": "VARCHAR",
    "last_error": "VARCHAR",
    "updated_at": "TIMESTAMP",
}


def _create_table_if_not_exists(db_connection, table_name, schema):
    columns_def = ", ".join([f"{name} {dtype}" for name, dtype in schema.items()])
    db_connection.execute(f"CREATE TABLE IF NOT EXISTS {table_name} ({columns_def});")


def _migrate_schema(db_connection):
    """
    Compares the canonical schema with the current DB schema and adds missing columns.
    """
    try:
        # 1. Migrate 'activities' table
        db_columns_df = db_connection.execute("PRAGMA table_info('activities')").fetchdf()
        db_columns = set(db_columns_df["name"]) if not db_columns_df.empty else set()

        canonical_columns = set(ACTIVITIES_SCHEMA.keys())
        columns_to_add = canonical_columns - db_columns

        if columns_to_add:
            logger.info(f"Found missing columns in 'activities', adding: {', '.join(columns_to_add)}")
            for col_name in columns_to_add:
                col_type = ACTIVITIES_SCHEMA[col_name]
                db_connection.execute(f"ALTER TABLE activities ADD COLUMN {col_name} {col_type}")

        # 2. Migrate 'activities_flyby' table
        # We need to check if table exists first
        table_exists = (
            db_connection.execute(
                "SELECT count(*) FROM information_schema.tables WHERE table_name = 'activities_flyby'"
            ).fetchone()[0]
            > 0
        )

        if table_exists:
            flyby_columns_df = db_connection.execute("PRAGMA table_info('activities_flyby')").fetchdf()
            flyby_db_columns = set(flyby_columns_df["name"]) if not flyby_columns_df.empty else set()

            canonical_flyby_columns = set(ACTIVITIES_FLYBY_SCHEMA.keys())
            flyby_columns_to_add = canonical_flyby_columns - flyby_db_columns

            if flyby_columns_to_add:
                logger.info(f"Found missing columns in 'activities_flyby', adding: {', '.join(flyby_columns_to_add)}")
                for col_name in flyby_columns_to_add:
                    col_type = ACTIVITIES_FLYBY_SCHEMA[col_name]
                    db_connection.execute(f"ALTER TABLE activities_flyby ADD COLUMN {col_name} {col_type}")

        logger.info("Schema migration completed.")
    except Exception as e:
        logger.warning(f"Could not perform schema migration: {e}")


def get_db_connection(database: str | Path, read_only: bool = False) -> duckdb.DuckDBPyConnection:
    env_config = load_env_config()
    key = env_config.get("duckdb_encryption_key") if env_config else None

    if not key:
        import os

        key = os.getenv("DUCKDB_ENCRYPTION_KEY")

    if key:
        try:
            # Use in-memory connection and attach the encrypted DB
            con = duckdb.connect()
            read_only_str = "TRUE" if read_only else "FALSE"
            attach_sql = (
                f"ATTACH '{database}' AS main_db (TYPE DUCKDB, READ_ONLY {read_only_str}, ENCRYPTION_KEY '{key}')"
            )
            con.execute(attach_sql)
            con.execute("USE main_db")
            return con
        except duckdb.Error as e:
            raise StorageError(f"Failed to open database with encryption key: {e}") from e

    # No key provided, standard connect
    con = duckdb.connect(database=database, read_only=read_only)
    return con


def _ensure_primary_keys(db_connection):
    """
    Checks if 'activities' and 'activities_flyby' tables have correct Primary Key constraints.
    If not, it recreates the tables with the correct schema, preserving data.
    """
    try:
        # 1. Check 'activities' table
        table_exists = (
            db_connection.execute(
                "SELECT count(*) FROM information_schema.tables WHERE table_name = 'activities'"
            ).fetchone()[0]
            > 0
        )

        if table_exists:
            # Check if run_id is a Primary Key
            columns_info = db_connection.execute("PRAGMA table_info('activities')").fetchdf()
            run_id_row = columns_info[columns_info["name"] == "run_id"]

            is_pk = False
            if not run_id_row.empty:
                is_pk = run_id_row.iloc[0]["pk"]

            if not is_pk:
                logger.info("Migrating 'activities' table to add Primary Key constraint...")
                with transaction(db_connection):
                    # Rename existing table
                    db_connection.execute("ALTER TABLE activities RENAME TO activities_old")

                    # Create new table with correct schema
                    _create_table_if_not_exists(db_connection, "activities", ACTIVITIES_SCHEMA)

                    # Copy data. We need to handle potential column mismatches if schema changed,
                    # but _migrate_schema should have handled adding columns.
                    # We'll select only columns that exist in both.
                    old_cols = set(columns_info["name"])
                    new_cols = set(ACTIVITIES_SCHEMA.keys())
                    common_cols = list(old_cols.intersection(new_cols))

                    cols_str = ", ".join(common_cols)

                    db_connection.execute(f"INSERT INTO activities ({cols_str}) SELECT {cols_str} FROM activities_old")

                    # Drop old table
                    db_connection.execute("DROP TABLE activities_old")
                logger.info("'activities' table migration complete.")

        # 2. Check 'activities_flyby' table
        flyby_exists = (
            db_connection.execute(
                "SELECT count(*) FROM information_schema.tables WHERE table_name = 'activities_flyby'"
            ).fetchone()[0]
            > 0
        )

        if flyby_exists:
            # Check if it has PK (composite)
            flyby_info = db_connection.execute("PRAGMA table_info('activities_flyby')").fetchdf()
            # activity_id and time_offset should be PKs
            pk_cols = flyby_info[flyby_info["pk"].astype(bool)]["name"].tolist()

            has_correct_pk = "activity_id" in pk_cols and "time_offset" in pk_cols

            if not has_correct_pk:
                logger.info("Migrating 'activities_flyby' table to add Primary Key constraint...")
                with transaction(db_connection):
                    db_connection.execute("ALTER TABLE activities_flyby RENAME TO activities_flyby_old")

                    _create_activities_flyby_table(db_connection)

                    old_cols = set(flyby_info["name"])
                    new_cols = set(ACTIVITIES_FLYBY_SCHEMA.keys())
                    common_cols = list(old_cols.intersection(new_cols))

                    cols_str = ", ".join(common_cols)

                    # Use INSERT OR IGNORE or handle duplicates if any
                    # Since we are adding a PK, duplicates might violate it.
                    # We'll use simple INSERT and let it fail if there are duplicates (user needs to know)

                    db_connection.execute(
                        f"INSERT INTO activities_flyby ({cols_str}) SELECT {cols_str} FROM activities_flyby_old"
                    )

                    db_connection.execute("DROP TABLE activities_flyby_old")
                logger.info("'activities_flyby' table migration complete.")

    except Exception as e:
        logger.error(f"Error checking/fixing database schema constraints: {e}")
        # We don't raise here to allow the script to try continuing,
        # but if this failed, subsequent operations might fail too.
        raise e


def init_db(db_path: str | Path) -> duckdb.DuckDBPyConnection:
    """
    Initializes the DuckDB database,
    creates or migrates the activities table and activities_flyby table.
    """
    con = get_db_connection(db_path, read_only=False)

    # Attempt to migrate schema first
    _migrate_schema(con)

    # Ensure Primary Keys exist (fixes schema constraints)
    _ensure_primary_keys(con)

    # Create table if it doesn't exist, using the canonical schema
    _create_table_if_not_exists(con, "activities", ACTIVITIES_SCHEMA)

    # Create activities_flyby table with composite primary key
    _create_activities_flyby_table(con)

    # Create queue table for pending flyby sync
    _create_table_if_not_exists(con, "activities_flyby_queue", FLYBY_QUEUE_SCHEMA)

    return con


def enqueue_flyby_activities(db_connection: duckdb.DuckDBPyConnection, activity_ids: list[int]) -> int:
    if not activity_ids:
        return 0
    df = pd.DataFrame({"activity_id": activity_ids})
    db_connection.register("temp_flyby_queue", df)
    try:
        db_connection.execute(
            """
            INSERT INTO activities_flyby_queue (activity_id, status, updated_at)
            SELECT activity_id, 'pending', NOW() FROM temp_flyby_queue
            ON CONFLICT (activity_id) DO NOTHING
            """
        )
    finally:
        db_connection.unregister("temp_flyby_queue")
    return len(activity_ids)


def list_pending_flyby_activities(db_connection: duckdb.DuckDBPyConnection) -> list[int]:
    try:
        rows = db_connection.execute(
            "SELECT activity_id FROM activities_flyby_queue ORDER BY activity_id"
        ).fetchall()
        return [row[0] for row in rows]
    except Exception:
        return []


def mark_flyby_activity_done(db_connection: duckdb.DuckDBPyConnection, activity_id: int) -> None:
    db_connection.execute("DELETE FROM activities_flyby_queue WHERE activity_id = ?", [activity_id])


def update_flyby_activity_error(
    db_connection: duckdb.DuckDBPyConnection,
    activity_id: int,
    status: str,
    last_error: str,
) -> None:
    db_connection.execute(
        """
        UPDATE activities_flyby_queue
        SET status = ?, last_error = ?, updated_at = NOW()
        WHERE activity_id = ?
        """,
        [status, last_error, activity_id],
    )


def _create_activities_flyby_table(db_connection):
    """
    Creates the activities_flyby table with proper primary key constraint.
    """
    columns_def = ", ".join([f"{name} {dtype}" for name, dtype in ACTIVITIES_FLYBY_SCHEMA.items()])
    # Add composite primary key and foreign key constraints.
    # DuckDB supports FOREIGN KEY constraints but not ON DELETE CASCADE.
    # We define the table with the constraint and let the application handle
    # cascading deletes if necessary.
    constraints = ", PRIMARY KEY (activity_id, time_offset), FOREIGN KEY (activity_id) REFERENCES activities(run_id)"
    create_sql = f"CREATE TABLE IF NOT EXISTS activities_flyby ({columns_def}{constraints});"

    try:
        db_connection.execute(create_sql)
    except Exception as e:
        logger.error(f"Failed to create or verify activities_flyby table: {e}")
        raise StorageError("Failed to create activities_flyby table") from e


def update_or_create_activities(db_connection: duckdb.DuckDBPyConnection, activities_df: pd.DataFrame) -> int:
    """
    Performs a batch "UPSERT" (insert on conflict update) operation for activities.
    Uses transaction context.
    """
    if activities_df.empty:
        return 0

    # Ensure DataFrame columns match the canonical schema order before inserting
    ordered_columns = [col for col in ACTIVITIES_SCHEMA if col in activities_df.columns]
    activities_df = activities_df[ordered_columns]

    # Register the DataFrame as a temporary table
    db_connection.register("temp_activities_df", activities_df)

    try:
        # Use a single SQL query to insert new activities and update existing ones
        update_cols = ", ".join([f"{col} = excluded.{col}" for col in ordered_columns if col != "run_id"])
        query = f"""
        INSERT INTO activities
        SELECT * FROM temp_activities_df
        ON CONFLICT (run_id) DO UPDATE SET {update_cols};
        """

        with transaction(db_connection):
            db_connection.execute(query)

        return len(activities_df)
    except Exception as e:
        logger.error(f"Failed to upsert activities: {e}")
        raise e
    finally:
        # Unregister the temporary table to clean up
        db_connection.unregister("temp_activities_df")


# Cache for geocoding results to avoid repeated API calls for the same location
_geocode_cache = {}


def _get_location_country(lat, lon):
    """
    Performs reverse geocoding with caching.
    """
    if pd.isna(lat) or pd.isna(lon):
        return ""

    # Use a tuple key for the cache
    cache_key = (round(lat, 4), round(lon, 4))
    if cache_key in _geocode_cache:
        return _geocode_cache[cache_key]

    try:
        location = get_geocoder().reverse(f"{lat},{lon}", language="zh-CN", timeout=10)
        country = location.raw.get("address", {}).get("country", "")
        _geocode_cache[cache_key] = country
        return country
    except Exception as e:
        logger.debug(f"Geocoding failed for ({lat}, {lon}): {e}")
        _geocode_cache[cache_key] = ""
        return ""


def get_dataframe_from_strava_activities(activities):
    """
    Converts a list of Strava activity objects to a pandas DataFrame,
    handling data transformation and geocoding.
    """
    if not activities:
        return pd.DataFrame()

    activities_data = []
    for activity in activities:
        gain = getattr(
            activity,
            "total_elevation_gain",
            getattr(activity, "elevation_gain", 0.0),
        )
        start_latlng = getattr(activity, "start_latlng", None)

        act_type = activity.type
        # Custom type detection based on name
        activity_name = getattr(activity, "name", "")
        if activity_name and (act_type == "Workout" or act_type == "WeightTraining"):
            lower_name = activity_name.lower()
            if "boxing" in lower_name or "拳击" in lower_name:
                act_type = "Boxing"

        record = {
            "run_id": activity.id,
            "name": activity.name,
            "distance": float(activity.distance),
            "moving_time": activity.moving_time.total_seconds(),
            "elapsed_time": activity.elapsed_time.total_seconds(),
            "type": act_type,
            "subtype": str(getattr(activity, "subtype", "")),
            "start_date": activity.start_date,
            "start_date_local": activity.start_date_local,
            "location_country": getattr(activity, "location_country", ""),
            "summary_polyline": activity.map.summary_polyline if activity.map else "",
            "average_heartrate": activity.average_heartrate or 0.0,
            "average_speed": float(activity.average_speed),
            "elevation_gain": float(gain or 0.0),
            "start_lat": start_latlng.lat if start_latlng else None,
            "start_lon": start_latlng.lon if start_latlng else None,
        }
        activities_data.append(record)

    df = pd.DataFrame(activities_data)

    # Identify rows that need geocoding
    needs_geocoding_mask = (df["location_country"] == "") | (df["location_country"] == "China")
    if needs_geocoding_mask.any():
        logger.info("Performing reverse geocoding for missing locations...")

        # Step 1: Identify unique, uncached coordinates that need to be fetched
        coords_to_fetch = df.loc[needs_geocoding_mask, ["start_lat", "start_lon"]].dropna().drop_duplicates()

        # Convert to tuples for caching and processing
        unique_coords = [(round(row.start_lat, 4), round(row.start_lon, 4)) for row in coords_to_fetch.itertuples()]

        # Filter out coordinates that are already in the cache
        uncached_coords = [coord for coord in unique_coords if coord not in _geocode_cache]

        # Step 2: Concurrently fetch data for uncached coordinates
        if uncached_coords:
            logger.info(f"Fetching {len(uncached_coords)} unique new locations...")
            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                # We just need to execute the tasks to populate the cache
                list(executor.map(lambda p: _get_location_country(p[0], p[1]), uncached_coords))

        # Step 3: Apply the now-cached results to the DataFrame
        geocoded_countries = df.loc[needs_geocoding_mask].apply(
            lambda row: _get_location_country(row["start_lat"], row["start_lon"]),
            axis=1,
        )
        df.loc[needs_geocoding_mask, "location_country"] = geocoded_countries
        logger.info("Geocoding complete.")

    # Drop temporary lat/lon columns before returning
    df = df.drop(columns=["start_lat", "start_lon"], errors="ignore")

    return df


def get_dataframes_for_fit_tables(activity, streams):
    """
    Converts Strava activity and streams object into a dictionary of DataFrames
    with data types suitable for database insertion.
    """

    from ..garmin_device_adaptor import (
        GARMIN_DEVICE_PRODUCT_ID,
        GARMIN_SOFTWARE_VERSION,
        MANUFACTURER,
    )

    dataframes = {}

    # Create fit_file_id DataFrame
    file_id_data = {
        "serial_number": [str(activity.id)],
        "time_created": [pd.to_datetime(activity.start_date)],
        "manufacturer": [MANUFACTURER],
        "product": [GARMIN_DEVICE_PRODUCT_ID],
        "software_version": [GARMIN_SOFTWARE_VERSION],
        "type": [4],  # 4 = activity file
    }
    dataframes["fit_file_id"] = pd.DataFrame(file_id_data)

    # Create fit_record DataFrame only if essential streams are available
    if streams and streams.get("time") and streams.get("latlng"):
        time_stream_data = streams.get("time").data
        record_data = {
            "activity_id": [activity.id] * len(time_stream_data),
            "timestamp": [
                pd.to_datetime(activity.start_date) + datetime.timedelta(seconds=s) for s in time_stream_data
            ],
            "position_lat": [latlng[0] for latlng in streams.get("latlng").data],
            "position_long": [latlng[1] for latlng in streams.get("latlng").data],
            "distance": streams.get("distance").data if streams.get("distance") else None,
            "altitude": streams.get("altitude").data if streams.get("altitude") else None,
            "speed": streams.get("velocity_smooth").data if streams.get("velocity_smooth") else None,
            "heart_rate": streams.get("heartrate").data if streams.get("heartrate") else None,
            "cadence": streams.get("cadence").data if streams.get("cadence") else None,
        }
        dataframes["fit_record"] = pd.DataFrame(record_data)
    else:
        dataframes["fit_record"] = pd.DataFrame(columns=FIT_RECORD_SCHEMA.keys())

    # Create fit_lap and fit_session DataFrames
    sport_map = {
        "Run": Sport.RUNNING.value,
        "Hike": Sport.HIKING.value,
        "Walk": Sport.WALKING.value,
        "EBikeRide": Sport.E_BIKING.value,
        "Swim": Sport.SWIMMING.value,
        "Ride": Sport.CYCLING.value,
        "Workout": Sport.TRAINING.value,
        "WeightTraining": Sport.TRAINING.value,
    }
    sport = sport_map.get(activity.type, Sport.GENERIC.value)

    # By default generic SubSport
    sub_sport = SubSport.GENERIC.value

    # Heuristic for specific sports based on name
    if sport == Sport.GENERIC.value or sport == Sport.TRAINING.value:
        # For Workout/WeightTraining (mapped to TRAINING), default to Strength Training
        if sport == Sport.TRAINING.value:
            sub_sport = SubSport.STRENGTH_TRAINING.value

        activity_name = getattr(activity, "name", "")
        if activity_name:
            lower_name = activity_name.lower()
            if "boxing" in lower_name or "拳击" in lower_name:
                sport = Sport.BOXING.value
                sub_sport = SubSport.GENERIC.value  # Boxing doesn't have specific subsport usually

    session_data = {
        "activity_id": [activity.id],
        "timestamp": [pd.to_datetime(activity.start_date) + activity.elapsed_time],
        "start_time": [pd.to_datetime(activity.start_date)],
        "total_elapsed_time": [activity.elapsed_time.total_seconds()],
        "total_timer_time": [activity.moving_time.total_seconds()],
        "total_distance": [float(activity.distance)],
        "avg_speed": [float(activity.average_speed)],
        "avg_heart_rate": [activity.average_heartrate],
        "avg_cadence": [activity.average_cadence],
        "sport": [sport],
        "sub_sport": [sub_sport],
        "name": [getattr(activity, "name", "Activity")],  # Add name for potential use in Sport message
    }
    dataframes["fit_session"] = pd.DataFrame(session_data)

    # Lap does not have sport, so create a copy and drop the column
    lap_data = session_data.copy()
    lap_data.pop("sport")
    dataframes["fit_lap"] = pd.DataFrame(lap_data)

    return dataframes


def convert_streams_to_flyby_dataframe(activity, streams):
    """
    Convert the Strava activity streams into a DataFrame
    """
    # Relaxed check: Only 'time' is strictly required for Flyby.
    # 'latlng' is optional for indoor/stationary activities.
    if not streams or not streams.get("time"):
        logger.warning(f"Activity {activity.id} missing time stream")
        return pd.DataFrame()

    try:
        time_data = streams.get("time").data

        # Handle LatLng (Optional for Indoor)
        latlng_stream = streams.get("latlng")
        if latlng_stream and latlng_stream.data:
            latlng_data = latlng_stream.data
            if len(time_data) != len(latlng_data):
                logger.warning(f"Activity {activity.id} has mismatched time/latlng data lengths")
                min_length = min(len(time_data), len(latlng_data))
                time_data = time_data[:min_length]
                latlng_data = latlng_data[:min_length]

            # Vectorized LatLng
            latlng_df = pd.DataFrame(latlng_data, columns=["lat", "lng"])
            lats = latlng_df["lat"].round(6).tolist()
            lngs = latlng_df["lng"].round(6).tolist()
        else:
            # No GPS data
            lats = [None] * len(time_data)
            lngs = [None] * len(time_data)

        flyby_data = {
            "activity_id": [activity.id] * len(time_data),
            "time_offset": time_data,
            "lat": lats,
            "lng": lngs,
        }

        # Helper to align stream length to time stream
        def get_aligned_stream_data(stream_name):
            stream = streams.get(stream_name)
            if stream and stream.data:
                data = stream.data
                if len(data) < len(time_data):
                    data.extend([None] * (len(time_data) - len(data)))
                elif len(data) > len(time_data):
                    data = data[: len(time_data)]
                return data
            return [None] * len(time_data)

        # Altitude
        alt_data = get_aligned_stream_data("altitude")
        flyby_data["alt"] = [int(alt) if alt is not None and not pd.isna(alt) else None for alt in alt_data]

        # Velocity / Pace
        velocity_data = get_aligned_stream_data("velocity_smooth")
        # Avoid division by zero
        # Pace = (1000 / 60) / velocity
        # If velocity is 0, pace is 0 (or infinite, but we use 0 for "stopped")

        # We can use numpy where
        # pace = np.where(vel > 0, (1000.0/60.0)/vel, 0.0)
        # But we also need to respect time_offset == 0 logic if present, though usually time[0]=0.

        # Let's keep it simple with list comp for complex logic or verify numpy logic
        pace_data = []
        for i, velocity in enumerate(velocity_data):
            if time_data[i] == 0:
                pace_data.append(0.0)
                continue
            if velocity is not None and not pd.isna(velocity) and velocity > 0:
                pace = (1000.0 / 60.0) / velocity
                if 1.0 <= pace <= 30.0:
                    pace_data.append(round(pace, 2))
                else:
                    pace_data.append(0.0)
            else:
                pace_data.append(0.0)
        flyby_data["pace"] = pace_data

        # Heart Rate
        hr_data = get_aligned_stream_data("heartrate")
        flyby_data["hr"] = [
            int(hr) if hr is not None and not pd.isna(hr) and 0 <= hr <= 255 else None for hr in hr_data
        ]

        # Distance
        dist_data = get_aligned_stream_data("distance")
        flyby_data["distance"] = [int(dist) if dist is not None and not pd.isna(dist) else None for dist in dist_data]

        # Cadence
        cad_data = get_aligned_stream_data("cadence")
        flyby_data["cadence"] = [int(c) if c is not None and not pd.isna(c) else None for c in cad_data]

        # Watts
        watts_data = get_aligned_stream_data("watts")
        flyby_data["watts"] = [int(w) if w is not None and not pd.isna(w) else None for w in watts_data]

        flyby_df = pd.DataFrame(flyby_data)

        flyby_df["activity_id"] = flyby_df["activity_id"].astype("int64")
        flyby_df["time_offset"] = flyby_df["time_offset"].astype("int32")

        logger.info(f"Converted {len(flyby_df)} flyby records for activity {activity.id}")
        return flyby_df

    except Exception as e:
        logger.error(f"Error converting streams to flyby dataframe for activity {activity.id}: {e}")
        return pd.DataFrame()


def store_flyby_data(db_connection, flyby_df):
    if flyby_df.empty:
        logger.info("No flyby data to store")
        return 0

    try:
        _create_activities_flyby_table(db_connection)

        expected_columns = set(ACTIVITIES_FLYBY_SCHEMA.keys())
        df_columns = set(flyby_df.columns)

        if not expected_columns.issubset(df_columns):
            missing_columns = expected_columns - df_columns
            logger.error(f"Missing required columns in flyby DataFrame: {missing_columns}")
            return 0

        ordered_columns = [col for col in ACTIVITIES_FLYBY_SCHEMA.keys() if col in flyby_df.columns]
        flyby_df_ordered = flyby_df[ordered_columns].copy()

        try:
            # Clean and convert data types in a more streamlined way
            flyby_df_ordered.dropna(subset=["activity_id", "time_offset"], inplace=True)
            flyby_df_ordered["activity_id"] = flyby_df_ordered["activity_id"].astype("int64")
            flyby_df_ordered["time_offset"] = flyby_df_ordered["time_offset"].astype("int32")
            flyby_df_ordered["lat"] = pd.to_numeric(flyby_df_ordered["lat"], errors="coerce")
            flyby_df_ordered["lng"] = pd.to_numeric(flyby_df_ordered["lng"], errors="coerce")
            flyby_df_ordered["alt"] = pd.to_numeric(flyby_df_ordered["alt"], errors="coerce").astype("Int16")
            flyby_df_ordered["pace"] = pd.to_numeric(flyby_df_ordered["pace"], errors="coerce").fillna(0.0)
            flyby_df_ordered["hr"] = pd.to_numeric(flyby_df_ordered["hr"], errors="coerce").astype("Int16")
            flyby_df_ordered["distance"] = pd.to_numeric(flyby_df_ordered["distance"], errors="coerce").astype("Int32")

            # New fields: cadence and watts
            # Use get in case they are missing from df (e.g. older data in memory)
            if "cadence" in flyby_df_ordered.columns:
                flyby_df_ordered["cadence"] = pd.to_numeric(flyby_df_ordered["cadence"], errors="coerce").astype(
                    "Int16"
                )
            else:
                flyby_df_ordered["cadence"] = None

            if "watts" in flyby_df_ordered.columns:
                flyby_df_ordered["watts"] = pd.to_numeric(flyby_df_ordered["watts"], errors="coerce").astype("Int16")
            else:
                flyby_df_ordered["watts"] = None

        except Exception as e:
            logger.error(f"Error converting flyby data types: {e}")
            return 0

        temp_table_name = "temp_flyby_data"
        db_connection.register(temp_table_name, flyby_df_ordered)

        try:
            columns_list = ", ".join(ordered_columns)
            values_list = ", ".join([f"temp.{col}" for col in ordered_columns])

            non_pk_columns = [col for col in ordered_columns if col not in ["activity_id", "time_offset"]]
            update_set_clause = ", ".join([f"{col} = excluded.{col}" for col in non_pk_columns])

            if update_set_clause:
                upsert_sql = f"""
                INSERT INTO activities_flyby ({columns_list})
                SELECT {values_list} FROM {temp_table_name} temp
                ON CONFLICT (activity_id, time_offset) DO UPDATE SET {update_set_clause}
                """
            else:
                upsert_sql = f"""
                INSERT INTO activities_flyby ({columns_list})
                SELECT {values_list} FROM {temp_table_name} temp
                ON CONFLICT (activity_id, time_offset) DO NOTHING
                """

            db_connection.execute(upsert_sql)

            records_processed = len(flyby_df_ordered)

            logger.info(f"Successfully processed {records_processed} flyby records")
            return records_processed

        except Exception as e:
            logger.error(f"Error executing flyby data UPSERT: {e}")
            try:
                logger.info("Attempting fallback INSERT operation...")
                insert_sql = f"""
                INSERT INTO activities_flyby ({columns_list})
                SELECT {values_list} FROM {temp_table_name} temp
                """
                db_connection.execute(insert_sql)
                records_inserted = len(flyby_df_ordered)
                logger.info(f"Fallback INSERT successful: {records_inserted} records")
                return records_inserted
            except Exception as e2:
                logger.error(f"Fallback INSERT also failed: {e2}")
                return 0

        finally:
            try:
                db_connection.unregister(temp_table_name)
            except Exception as e:
                logger.debug(f"Failed to unregister temp table {temp_table_name}: {e}")

    except Exception as e:
        logger.error(f"Unexpected error in store_flyby_data: {e}")
        return 0


def write_fit_dataframes(db_connection, dataframes):
    """
    Writes a dictionary of DataFrames to their respective tables in the database
    using DuckDB's native virtual table and INSERT INTO functionality.
    """
    if not dataframes:
        return

    schemas = {
        "fit_file_id": FIT_FILE_ID_SCHEMA,
        "fit_record": FIT_RECORD_SCHEMA,
        "fit_lap": FIT_LAP_SCHEMA,
        "fit_session": FIT_SESSION_SCHEMA,
    }

    for table_name, df in dataframes.items():
        if df.empty:
            continue

        schema = schemas.get(table_name)
        if not schema:
            logger.warning(f"Warning: No schema defined for table {table_name}. Skipping.")
            continue

        try:
            # 1. Ensure the target table exists with the correct schema.
            _create_table_if_not_exists(db_connection, table_name, schema)

            # 2. Register the Pandas DataFrame as a temporary virtual table.
            db_connection.register(f"temp_{table_name}", df)

            # 3. Use a SQL INSERT statement to copy data from the virtual table.
            columns = ", ".join(df.columns)
            # Use ON CONFLICT DO NOTHING to avoid errors with duplicate primary keys
            # This is relevant for fit_file_id and fit_session which have PRIMARY KEYs
            if "PRIMARY KEY" in " ".join(schema.values()):
                db_connection.execute(
                    f"""
                    INSERT INTO {table_name} ({columns})
                    SELECT {columns} FROM temp_{table_name}
                    ON CONFLICT DO NOTHING
                    """
                )
            else:
                db_connection.execute(f"INSERT INTO {table_name} ({columns}) SELECT {columns} FROM temp_{table_name}")

            # 4. Unregister the virtual table to clean up.
            db_connection.unregister(f"temp_{table_name}")

            logger.info(f"Successfully saved {len(df)} records to table '{table_name}'.")

        except duckdb.Error as e:
            raise StorageError(f"Failed to save DataFrame to table '{table_name}': {e}") from e

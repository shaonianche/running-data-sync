import concurrent.futures
import datetime
import ssl

import certifi
import duckdb
import geopy
import pandas as pd
from fit_tool.profile.profile_type import Sport
from geopy.geocoders import Nominatim

geopy.geocoders.options.default_user_agent = "running-data-sync"
# reverse the location (lat, lon) -> location detail
ctx = ssl.create_default_context(cafile=certifi.where())
geopy.geocoders.options.default_ssl_context = ctx
g = Nominatim(user_agent="running-data-sync", timeout=10)

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


def _create_table_if_not_exists(db_connection, table_name, schema):
    columns_def = ", ".join([f"{name} {dtype}" for name, dtype in schema.items()])
    db_connection.execute(f"CREATE TABLE IF NOT EXISTS {table_name} ({columns_def});")


def _migrate_schema(db_connection):
    """
    Compares the canonical schema with the current DB schema and adds missing columns.
    """
    try:
        # Get current schema from the database
        db_columns_df = db_connection.execute(
            "PRAGMA table_info('activities')"
        ).fetchdf()
        db_columns = set(db_columns_df["name"]) if not db_columns_df.empty else set()

        # Get canonical schema from the code
        canonical_columns = set(ACTIVITIES_SCHEMA.keys())

        # Find missing columns
        columns_to_add = canonical_columns - db_columns

        if columns_to_add:
            print(f"Found missing columns, adding: {', '.join(columns_to_add)}")
            for col_name in columns_to_add:
                col_type = ACTIVITIES_SCHEMA[col_name]
                db_connection.execute(
                    f"ALTER TABLE activities ADD COLUMN {col_name} {col_type}"
                )
            print("Schema migration completed.")
    except Exception as e:
        # This might happen if the table does not exist yet, which is fine.
        # The subsequent CREATE TABLE will handle it.
        print(f"Could not perform schema migration: {e}")


def init_db(db_path):
    """
    Initializes the DuckDB database, creates or migrates the activities table.
    """
    con = duckdb.connect(database=db_path, read_only=False)

    # Attempt to migrate schema first
    _migrate_schema(con)

    # Create table if it doesn't exist, using the canonical schema
    _create_table_if_not_exists(con, "activities", ACTIVITIES_SCHEMA)

    return con


def update_or_create_activities(db_connection, activities_df):
    """
    Performs a batch "UPSERT" (insert on conflict update) operation for activities.
    """
    if activities_df.empty:
        return 0

    # Ensure DataFrame columns match the canonical schema order before inserting
    ordered_columns = [col for col in ACTIVITIES_SCHEMA if col in activities_df.columns]
    activities_df = activities_df[ordered_columns]

    # Register the DataFrame as a temporary table
    db_connection.register("temp_activities_df", activities_df)

    # Use a single SQL query to insert new activities and update existing ones
    update_cols = ", ".join([
        f"{col} = excluded.{col}" for col in ordered_columns if col != "run_id"
    ])
    query = f"""
    INSERT INTO activities
    SELECT * FROM temp_activities_df
    ON CONFLICT (run_id) DO UPDATE SET {update_cols};
    """

    db_connection.execute(query)
    # Unregister the temporary table to clean up
    db_connection.unregister("temp_activities_df")
    return len(activities_df)


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
        location = g.reverse(f"{lat},{lon}", language="zh-CN", timeout=10)
        country = location.raw.get("address", {}).get("country", "")
        _geocode_cache[cache_key] = country
        return country
    except Exception:
        # On failure, cache an empty result to avoid retrying
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
        record = {
            "run_id": activity.id,
            "name": activity.name,
            "distance": float(activity.distance),
            "moving_time": activity.moving_time.total_seconds(),
            "elapsed_time": activity.elapsed_time.total_seconds(),
            "type": activity.type,
            "subtype": str(activity.subtype),
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
    needs_geocoding_mask = (df["location_country"] == "") | (
        df["location_country"] == "China"
    )
    if needs_geocoding_mask.any():
        print("Performing reverse geocoding for missing locations...")

        # Step 1: Identify unique, uncached coordinates that need to be fetched
        coords_to_fetch = (
            df.loc[needs_geocoding_mask, ["start_lat", "start_lon"]]
            .dropna()
            .drop_duplicates()
        )

        # Convert to tuples for caching and processing
        unique_coords = [
            (round(row.start_lat, 4), round(row.start_lon, 4))
            for row in coords_to_fetch.itertuples()
        ]

        # Filter out coordinates that are already in the cache
        uncached_coords = [
            coord for coord in unique_coords if coord not in _geocode_cache
        ]

        # Step 2: Concurrently fetch data for uncached coordinates
        if uncached_coords:
            print(f"Fetching {len(uncached_coords)} unique new locations...")
            with concurrent.futures.ThreadPoolExecutor(max_workers=5) as executor:
                # We just need to execute the tasks to populate the cache
                list(
                    executor.map(
                        lambda p: _get_location_country(p[0], p[1]), uncached_coords
                    )
                )

        # Step 3: Apply the now-cached results to the DataFrame
        geocoded_countries = df.loc[needs_geocoding_mask].apply(
            lambda row: _get_location_country(row["start_lat"], row["start_lon"]),
            axis=1,
        )
        df.loc[needs_geocoding_mask, "location_country"] = geocoded_countries
        print("Geocoding complete.")

    # Drop temporary lat/lon columns before returning
    df = df.drop(columns=["start_lat", "start_lon"], errors="ignore")

    return df


def get_dataframes_for_fit_tables(activity, streams):
    """
    Converts Strava activity and streams object into a dictionary of DataFrames
    with data types suitable for database insertion.
    """

    from garmin_device_adaptor import (
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

    # Create fit_record DataFrame
    time_stream_data = streams.get("time").data
    record_data = {
        "activity_id": [activity.id] * len(time_stream_data),
        "timestamp": [
            pd.to_datetime(activity.start_date) + datetime.timedelta(seconds=s)
            for s in time_stream_data
        ],
        "position_lat": [latlng[0] for latlng in streams.get("latlng").data],
        "position_long": [latlng[1] for latlng in streams.get("latlng").data],
        "distance": streams.get("distance").data if streams.get("distance") else None,
        "altitude": streams.get("altitude").data if streams.get("altitude") else None,
        "speed": streams.get("velocity_smooth").data
        if streams.get("velocity_smooth")
        else None,
        "heart_rate": streams.get("heartrate").data
        if streams.get("heartrate")
        else None,
        "cadence": streams.get("cadence").data if streams.get("cadence") else None,
    }
    dataframes["fit_record"] = pd.DataFrame(record_data)

    # Create fit_lap and fit_session DataFrames
    sport_map = {
        "Run": Sport.RUNNING.value,
        "Hike": Sport.HIKING.value,
        "Walk": Sport.WALKING.value,
        "EBikeRide": Sport.E_BIKING.value,
        "Swim": Sport.SWIMMING.value,
        "Ride": Sport.CYCLING.value,
    }
    sport = sport_map.get(activity.type, Sport.GENERIC.value)

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
    }
    dataframes["fit_session"] = pd.DataFrame(session_data)

    # Lap does not have sport, so create a copy and drop the column
    lap_data = session_data.copy()
    lap_data.pop("sport")
    dataframes["fit_lap"] = pd.DataFrame(lap_data)

    return dataframes


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
            print(f"Warning: No schema defined for table {table_name}. Skipping.")
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
                db_connection.execute(
                    f"INSERT INTO {table_name} ({columns}) SELECT {columns} FROM temp_{table_name}"
                )

            # 4. Unregister the virtual table to clean up.
            db_connection.unregister(f"temp_{table_name}")

            print(f"Successfully saved {len(df)} records to table '{table_name}'.")

        except Exception as e:
            print(f"Failed to save DataFrame to table '{table_name}': {e}")

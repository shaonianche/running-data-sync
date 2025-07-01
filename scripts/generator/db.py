import concurrent.futures
import ssl

import certifi
import duckdb
import geopy
import pandas as pd
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
    columns_def = ", ".join([
        f"{name} {dtype}" for name, dtype in ACTIVITIES_SCHEMA.items()
    ])
    con.execute(f"CREATE TABLE IF NOT EXISTS activities ({columns_def});")

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

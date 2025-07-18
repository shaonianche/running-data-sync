import concurrent.futures
import datetime
import ssl

import certifi
import duckdb
import geopy
import pandas as pd
from fit_tool.profile.profile_type import Sport
from geopy.geocoders import Nominatim

from utils import get_logger

logger = get_logger(__name__)
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

# Schema for the activities_flyby table
ACTIVITIES_FLYBY_SCHEMA = {
    "activity_id": "BIGINT NOT NULL",
    "time_offset": "INTEGER NOT NULL",
    "lat": "DECIMAL(9, 6)",
    "lng": "DECIMAL(9, 6)",
    "alt": "SMALLINT",
    "pace": "DECIMAL(5, 2)",
    "hr": "TINYINT",
    "distance": "INTEGER",
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
        db_columns_df = db_connection.execute("PRAGMA table_info('activities')").fetchdf()
        db_columns = set(db_columns_df["name"]) if not db_columns_df.empty else set()

        # Get canonical schema from the code
        canonical_columns = set(ACTIVITIES_SCHEMA.keys())

        # Find missing columns
        columns_to_add = canonical_columns - db_columns

        if columns_to_add:
            logger.info(f"Found missing columns, adding: {', '.join(columns_to_add)}")
            for col_name in columns_to_add:
                col_type = ACTIVITIES_SCHEMA[col_name]
                db_connection.execute(f"ALTER TABLE activities ADD COLUMN {col_name} {col_type}")
            logger.info("Schema migration completed.")
    except Exception as e:
        # This might happen if the table does not exist yet, which is fine.
        # The subsequent CREATE TABLE will handle it.
        logger.warning(f"Could not perform schema migration: {e}")


def init_db(db_path):
    """
    Initializes the DuckDB database,
    creates or migrates the activities table and activities_flyby table.
    """
    con = duckdb.connect(database=db_path, read_only=False)

    # Attempt to migrate schema first
    _migrate_schema(con)

    # Create table if it doesn't exist, using the canonical schema
    _create_table_if_not_exists(con, "activities", ACTIVITIES_SCHEMA)

    # Create activities_flyby table with composite primary key
    _create_activities_flyby_table(con)

    return con


def _create_activities_flyby_table(db_connection):
    """
    Creates the activities_flyby table with proper primary key constraint.
    """
    try:
        # Check if table exists
        table_exists = db_connection.execute("""
            SELECT COUNT(*) as count FROM information_schema.tables 
            WHERE table_name = 'activities_flyby'
        """).fetchone()

        if table_exists and table_exists[0] > 0:
            logger.info("activities_flyby table already exists")
            return

        # Create table with composite primary key
        create_table_sql = """
        CREATE TABLE IF NOT EXISTS activities_flyby (
            activity_id BIGINT NOT NULL,
            time_offset INTEGER NOT NULL,
            lat DECIMAL(9, 6),
            lng DECIMAL(9, 6),
            alt SMALLINT,
            pace DECIMAL(5, 2),
            hr TINYINT,
            distance INTEGER,
            PRIMARY KEY (activity_id, time_offset),
            FOREIGN KEY (activity_id) REFERENCES activities(run_id) ON DELETE CASCADE
        );
        """

        db_connection.execute(create_table_sql)
        logger.info("Created activities_flyby table successfully")

    except Exception as e:
        logger.warning(f"Could not create activities_flyby table: {e}")
        # Fallback to simple table creation without foreign key
        try:
            simple_create_sql = """
            CREATE TABLE IF NOT EXISTS activities_flyby (
                activity_id BIGINT NOT NULL,
                time_offset INTEGER NOT NULL,
                lat DECIMAL(9, 6),
                lng DECIMAL(9, 6),
                alt SMALLINT,
                pace DECIMAL(5, 2),
                hr TINYINT,
                distance INTEGER,
                PRIMARY KEY (activity_id, time_offset)
            );
            """
            db_connection.execute(simple_create_sql)
            logger.info("Created activities_flyby table without foreign key constraint")
        except Exception as e2:
            logger.error(f"Failed to create activities_flyby table: {e2}")


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
    update_cols = ", ".join([f"{col} = excluded.{col}" for col in ordered_columns if col != "run_id"])
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


def convert_streams_to_flyby_dataframe(activity, streams):
    """
    将 Strava 流数据转换为 flyby DataFrame 格式

    参数：
        activity: Strava 活动对象
        streams: Strava 流数据字典

    返回：
        pandas.DataFrame: 符合 ACTIVITIES_FLYBY_SCHEMA 的 DataFrame
    """
    if not streams or not streams.get("time") or not streams.get("latlng"):
        logger.warning(f"Activity {activity.id} missing essential streams (time/latlng)")
        return pd.DataFrame()

    try:
        # 获取基础流数据
        time_data = streams.get("time").data
        latlng_data = streams.get("latlng").data

        # 确保时间和位置数据长度一致
        if len(time_data) != len(latlng_data):
            logger.warning(f"Activity {activity.id} has mismatched time/latlng data lengths")
            min_length = min(len(time_data), len(latlng_data))
            time_data = time_data[:min_length]
            latlng_data = latlng_data[:min_length]

        # 构建基础数据
        flyby_data = {
            "activity_id": [activity.id] * len(time_data),
            "time_offset": time_data,  # 时间偏移（秒）
            "lat": [round(float(latlng[0]), 6) if latlng[0] is not None else None for latlng in latlng_data],
            "lng": [round(float(latlng[1]), 6) if latlng[1] is not None else None for latlng in latlng_data],
        }

        # 处理海拔数据
        altitude_stream = streams.get("altitude")
        if altitude_stream and altitude_stream.data:
            alt_data = altitude_stream.data
            # 确保长度匹配，截断或填充 None
            if len(alt_data) < len(time_data):
                alt_data.extend([None] * (len(time_data) - len(alt_data)))
            elif len(alt_data) > len(time_data):
                alt_data = alt_data[: len(time_data)]

            flyby_data["alt"] = [int(alt) if alt is not None and not pd.isna(alt) else None for alt in alt_data]
        else:
            flyby_data["alt"] = [None] * len(time_data)

        # 处理配速数据（从 velocity_smooth 计算）
        velocity_stream = streams.get("velocity_smooth")
        if velocity_stream and velocity_stream.data:
            velocity_data = velocity_stream.data
            # 确保长度匹配
            if len(velocity_data) < len(time_data):
                velocity_data.extend([None] * (len(time_data) - len(velocity_data)))
            elif len(velocity_data) > len(time_data):
                velocity_data = velocity_data[: len(time_data)]

            # 计算配速：(1000.0 / 60.0) * (1.0 / 速度) 分钟/公里
            # 速度单位：米/秒，配速单位：分钟/公里
            pace_data = []
            for velocity in velocity_data:
                if velocity is not None and not pd.isna(velocity) and velocity > 0:
                    pace = (1000.0 / 60.0) / velocity
                    # 限制配速在合理范围内（1-30 分钟/公里）
                    if 1.0 <= pace <= 30.0:
                        pace_data.append(round(pace, 2))
                    else:
                        pace_data.append(None)
                else:
                    pace_data.append(None)
            flyby_data["pace"] = pace_data
        else:
            flyby_data["pace"] = [None] * len(time_data)

        # 处理心率数据
        heartrate_stream = streams.get("heartrate")
        if heartrate_stream and heartrate_stream.data:
            hr_data = heartrate_stream.data
            # 确保长度匹配
            if len(hr_data) < len(time_data):
                hr_data.extend([None] * (len(time_data) - len(hr_data)))
            elif len(hr_data) > len(time_data):
                hr_data = hr_data[: len(time_data)]

            # 转换为 TINYINT 范围（0-255），心率通常在 40-220 之间
            flyby_data["hr"] = [
                int(hr) if hr is not None and not pd.isna(hr) and 0 <= hr <= 255 else None for hr in hr_data
            ]
        else:
            flyby_data["hr"] = [None] * len(time_data)

        # 处理距离数据
        distance_stream = streams.get("distance")
        if distance_stream and distance_stream.data:
            dist_data = distance_stream.data
            # 确保长度匹配
            if len(dist_data) < len(time_data):
                dist_data.extend([None] * (len(time_data) - len(dist_data)))
            elif len(dist_data) > len(time_data):
                dist_data = dist_data[: len(time_data)]

            # 转换为 INTEGER（米）
            flyby_data["distance"] = [
                int(dist) if dist is not None and not pd.isna(dist) else None for dist in dist_data
            ]
        else:
            flyby_data["distance"] = [None] * len(time_data)

        # 创建 DataFrame
        flyby_df = pd.DataFrame(flyby_data)

        # 确保数据类型符合 schema 要求
        flyby_df["activity_id"] = flyby_df["activity_id"].astype("int64")
        flyby_df["time_offset"] = flyby_df["time_offset"].astype("int32")

        logger.info(f"Converted {len(flyby_df)} flyby records for activity {activity.id}")
        return flyby_df

    except Exception as e:
        logger.error(f"Error converting streams to flyby dataframefor activity {activity.id}: {e}")
        return pd.DataFrame()


def store_flyby_data(db_connection, flyby_df):
    """
    将 flyby 数据存储到 activities_flyby 表

    参数：
        db_connection: 数据库连接
        flyby_df: flyby 数据 DataFrame

    返回：
        int: 存储的记录数量
    """
    if flyby_df.empty:
        logger.info("No flyby data to store")
        return 0

    try:
        # 确保 activities_flyby 表存在
        _create_activities_flyby_table(db_connection)

        # 验证 DataFrame 列是否符合 schema
        expected_columns = set(ACTIVITIES_FLYBY_SCHEMA.keys())
        df_columns = set(flyby_df.columns)

        if not expected_columns.issubset(df_columns):
            missing_columns = expected_columns - df_columns
            logger.error(f"Missing required columns in flyby DataFrame: {missing_columns}")
            return 0

        # 选择符合 schema 的列，确保顺序正确
        ordered_columns = [col for col in ACTIVITIES_FLYBY_SCHEMA.keys() if col in flyby_df.columns]
        flyby_df_ordered = flyby_df[ordered_columns].copy()

        # 数据类型验证和转换
        try:
            # 确保 activity_id 和 time_offset 不为空（主键字段）
            flyby_df_ordered = flyby_df_ordered.dropna(subset=["activity_id", "time_offset"])

            if flyby_df_ordered.empty:
                logger.warning("No valid flyby records after removing null primary key values")
                return 0

            # 转换数据类型以匹配 schema
            flyby_df_ordered["activity_id"] = flyby_df_ordered["activity_id"].astype("int64")
            flyby_df_ordered["time_offset"] = flyby_df_ordered["time_offset"].astype("int32")

            # 处理可选字段的数据类型
            if "lat" in flyby_df_ordered.columns:
                flyby_df_ordered["lat"] = pd.to_numeric(flyby_df_ordered["lat"], errors="coerce")
            if "lng" in flyby_df_ordered.columns:
                flyby_df_ordered["lng"] = pd.to_numeric(flyby_df_ordered["lng"], errors="coerce")
            if "alt" in flyby_df_ordered.columns:
                flyby_df_ordered["alt"] = pd.to_numeric(flyby_df_ordered["alt"], errors="coerce").astype("Int16")
            if "pace" in flyby_df_ordered.columns:
                flyby_df_ordered["pace"] = pd.to_numeric(flyby_df_ordered["pace"], errors="coerce")
            if "hr" in flyby_df_ordered.columns:
                flyby_df_ordered["hr"] = pd.to_numeric(flyby_df_ordered["hr"], errors="coerce").astype("Int8")
            if "distance" in flyby_df_ordered.columns:
                flyby_df_ordered["distance"] = pd.to_numeric(flyby_df_ordered["distance"], errors="coerce").astype(
                    "Int32"
                )

        except Exception as e:
            logger.error(f"Error converting flyby data types: {e}")
            return 0

        # 注册 DataFrame 为临时表
        temp_table_name = "temp_flyby_data"
        db_connection.register(temp_table_name, flyby_df_ordered)

        try:
            # 使用 UPSERT 操作处理重复数据
            # DuckDB 支持 ON CONFLICT DO UPDATE 语法
            columns_list = ", ".join(ordered_columns)
            values_list = ", ".join([f"temp.{col}" for col in ordered_columns])

            # 构建 UPDATE SET 子句，排除主键字段
            non_pk_columns = [col for col in ordered_columns if col not in ["activity_id", "time_offset"]]
            update_set_clause = ", ".join([f"{col} = temp.{col}" for col in non_pk_columns])

            if update_set_clause:
                upsert_sql = f"""
                INSERT INTO activities_flyby ({columns_list})
                SELECT {values_list} FROM {temp_table_name} temp
                ON CONFLICT (activity_id, time_offset) DO UPDATE SET {update_set_clause}
                """
            else:
                # 如果没有非主键列需要更新，使用 DO NOTHING
                upsert_sql = f"""
                INSERT INTO activities_flyby ({columns_list})
                SELECT {values_list} FROM {temp_table_name} temp
                ON CONFLICT (activity_id, time_offset) DO NOTHING
                """

            # 执行 UPSERT 操作
            db_connection.execute(upsert_sql)

            # 获取实际插入/更新的记录数
            records_processed = len(flyby_df_ordered)

            logger.info(f"Successfully processed {records_processed} flyby records")
            return records_processed

        except Exception as e:
            logger.error(f"Error executing flyby data UPSERT: {e}")
            # 尝试简单的 INSERT 操作作为 fallback
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
            # 清理临时表
            try:
                db_connection.unregister(temp_table_name)
            except Exception:
                pass  # 忽略清理错误

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

        except Exception as e:
            logger.error(f"Failed to save DataFrame to table '{table_name}': {e}")

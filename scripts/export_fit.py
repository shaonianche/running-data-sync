import os
import sys

import duckdb  # noqa: F401
import pandas as pd
from .config import FIT_FOLDER, SQL_FILE
from .garmin_device_adaptor import GARMIN_DEVICE_PRODUCT_ID, GARMIN_SOFTWARE_VERSION, MANUFACTURER
from .generator import Generator
from .generator.db import get_db_connection

from .utils import get_logger, load_env_config

logger = get_logger(__name__)

# Try/except import for fit_tool to give better error message
try:
    from fit_tool.profile.profile_type import Sport, SubSport
except ImportError:
    logger.error("Could not import fit_tool. Please ensure it is installed correctly.")
    sys.exit(1)


def validate_activity(con, activity_id):
    """
    Check if activity exists and return the summary row.
    """
    try:
        query = f"SELECT * FROM activities WHERE run_id = {activity_id}"
        df = con.execute(query).fetchdf()
        if df.empty:
            return None
        return df.iloc[0]
    except Exception as e:
        logger.error(f"Error validating activity: {e}")
        return None


def fetch_flyby_data(con, activity_id):
    """
    Fetch detailed track points.
    """
    try:
        query = f"SELECT * FROM activities_flyby WHERE activity_id = {activity_id} ORDER BY time_offset"
        df = con.execute(query).fetchdf()
        return df
    except Exception as e:
        logger.error(f"Error fetching flyby data: {e}")
        return pd.DataFrame()


def calculate_laps_from_records(fit_record, activity_id, start_date):
    """
    Generate 1km laps from record data.
    """
    if fit_record.empty or "distance" not in fit_record.columns:
        return None

    # Drop records without distance and ensure sorted
    df = fit_record.dropna(subset=["distance"]).sort_values("timestamp").reset_index(drop=True)
    if df.empty:
        return None

    laps = []
    start_idx = 0
    lap_start_dist = df.iloc[0]["distance"]
    lap_start_time = df.iloc[0]["timestamp"]
    split_dist_meters = 1000.0

    for i in range(len(df)):
        curr_dist = df.iloc[i]["distance"]
        dist_covered = curr_dist - lap_start_dist

        if dist_covered >= split_dist_meters:
            end_time = df.iloc[i]["timestamp"]
            # Slice range: start_idx (exclusive) to i (inclusive)
            seg_start = start_idx + 1 if start_idx < i else start_idx
            segment = df.iloc[seg_start : i + 1]

            elapsed_time = (end_time - lap_start_time).total_seconds()
            distance = dist_covered

            # Calculate averages
            if elapsed_time > 0:
                avg_speed = distance / elapsed_time
            elif "speed" in segment and not segment["speed"].isnull().all():
                avg_speed = segment["speed"].mean()
            else:
                avg_speed = 0.0

            avg_hr = segment["heart_rate"].mean() if "heart_rate" in segment else None
            avg_cadence = segment["cadence"].mean() if "cadence" in segment else None
            avg_power = segment["power"].mean() if "power" in segment else None

            laps.append(
                {
                    "activity_id": activity_id,
                    "timestamp": end_time,
                    "start_time": lap_start_time,
                    "total_elapsed_time": elapsed_time,
                    "total_timer_time": elapsed_time,
                    "total_distance": distance,
                    "avg_speed": avg_speed,
                    "avg_heart_rate": int(avg_hr) if pd.notna(avg_hr) else None,
                    "avg_cadence": int(avg_cadence) if pd.notna(avg_cadence) else None,
                    "avg_power": int(avg_power) if pd.notna(avg_power) else None,
                }
            )

            # Reset for next lap
            start_idx = i
            lap_start_dist = curr_dist
            lap_start_time = end_time

    # Handle final lap (remainder)
    if start_idx < len(df) - 1:
        i = len(df) - 1
        end_time = df.iloc[i]["timestamp"]
        curr_dist = df.iloc[i]["distance"]
        dist_covered = curr_dist - lap_start_dist
        elapsed_time = (end_time - lap_start_time).total_seconds()

        if dist_covered > 10 or elapsed_time > 5:
            seg_start = start_idx + 1 if start_idx < i else start_idx
            segment = df.iloc[seg_start : i + 1]

            if elapsed_time > 0:
                avg_speed = dist_covered / elapsed_time
            elif "speed" in segment and not segment["speed"].isnull().all():
                avg_speed = segment["speed"].mean()
            else:
                avg_speed = 0.0

            avg_hr = segment["heart_rate"].mean() if "heart_rate" in segment else None
            avg_cadence = segment["cadence"].mean() if "cadence" in segment else None
            avg_power = segment["power"].mean() if "power" in segment else None

            laps.append(
                {
                    "activity_id": activity_id,
                    "timestamp": end_time,
                    "start_time": lap_start_time,
                    "total_elapsed_time": elapsed_time,
                    "total_timer_time": elapsed_time,
                    "total_distance": dist_covered,
                    "avg_speed": avg_speed,
                    "avg_heart_rate": int(avg_hr) if pd.notna(avg_hr) else None,
                    "avg_cadence": int(avg_cadence) if pd.notna(avg_cadence) else None,
                    "avg_power": int(avg_power) if pd.notna(avg_power) else None,
                }
            )

    return pd.DataFrame(laps) if laps else None


def construct_dataframes(activity_row, flyby_df):
    """
    Build the dictionary of DataFrames required by the Generator.
    """
    activity_id = activity_row["run_id"]
    start_date = pd.to_datetime(activity_row["start_date"])

    # 1. File ID (Header)
    file_id_data = {
        "serial_number": [str(activity_id)],
        "time_created": [start_date],
        "manufacturer": [MANUFACTURER],
        "product": [GARMIN_DEVICE_PRODUCT_ID],
        "software_version": [GARMIN_SOFTWARE_VERSION],
        "type": [4],  # Activity
    }
    fit_file_id = pd.DataFrame(file_id_data)

    # 2. Records (Track Points)
    if not flyby_df.empty:
        timestamps = [start_date + pd.Timedelta(seconds=int(offset)) for offset in flyby_df["time_offset"]]

        def pace_to_speed(p):
            if pd.isna(p) or p == 0:
                return 0.0
            return (1000.0 / 60.0) / float(p)

        speeds = [pace_to_speed(p) for p in flyby_df["pace"]]

        # Stride Length Calculation: Speed (m/s) / (Cadence (spm) / 60)
        # Note: Strava cadence is usually SPM (steps per minute, both legs).
        # stride length = speed / (cadence / 60)
        stride_lengths = []
        cadences = []
        watts = []

        has_cadence = "cadence" in flyby_df.columns
        has_watts = "watts" in flyby_df.columns

        for i in range(len(flyby_df)):
            s = speeds[i]
            c = float(flyby_df["cadence"].iloc[i]) if has_cadence and pd.notna(flyby_df["cadence"].iloc[i]) else 0.0
            w = float(flyby_df["watts"].iloc[i]) if has_watts and pd.notna(flyby_df["watts"].iloc[i]) else None

            cadences.append(c if c > 0 else None)
            watts.append(w)

            if s > 0 and c > 0:
                # Speed (m/s) / (Steps/sec)
                # c is steps per minute. c/60 is steps per second.
                # If c is ~180, c/60 = 3 steps/sec.
                # If s is 3.33 m/s (5:00 pace), stride = 3.33 / 3 = 1.11 meters. Checks out.
                # Use *1000 for mm if FIT requires mm, but typically float meters is fine for internal dataframe,
                # mapped to fit_tool field. fit_tool expects meters?
                # Checking fit_tool RecordMessage: step_length is usually in mm or m?
                # Standard FIT is meters for step_length. But fit_tool uses specific units.
                # Usually best to store as float meters.
                sl = s / (c / 60.0)
                # Filter unrealistic values (e.g. > 3 meters)
                if 0.2 < sl < 3.0:
                    stride_lengths.append(sl)
                else:
                    stride_lengths.append(None)
            else:
                stride_lengths.append(None)

        record_data = {
            "timestamp": timestamps,
            "position_lat": flyby_df["lat"].astype(float),
            "position_long": flyby_df["lng"].astype(float),
            "distance": flyby_df["distance"].astype(float),
            "altitude": flyby_df["alt"].astype(float),
            "speed": speeds,
            "heart_rate": flyby_df["hr"].astype(float) if "hr" in flyby_df else None,
            "cadence": cadences,
            "power": watts,
            "step_length": stride_lengths,
        }
        fit_record = pd.DataFrame(record_data)
    else:
        fit_record = pd.DataFrame()

    # 3. Session (Summary)
    # Define Sport and SubSport mappings
    # Default to Generic/Generic
    sport = Sport.GENERIC.value
    sub_sport = SubSport.GENERIC.value

    act_type = activity_row["type"]

    # Logic to determine if we should suppress distance/speed/gps for stationary sports
    is_stationary = False

    # Comprehensive Mapping
    if act_type == "Run":
        sport = Sport.RUNNING.value
        sub_sport = SubSport.STREET.value
    elif act_type == "TrailRun":
        sport = Sport.RUNNING.value
        sub_sport = SubSport.TRAIL.value
    elif act_type == "Treadmill":
        sport = Sport.RUNNING.value
        sub_sport = SubSport.TREADMILL.value
    elif act_type == "VirtualRun":
        sport = Sport.RUNNING.value
        sub_sport = SubSport.VIRTUAL_ACTIVITY.value
    elif act_type == "Walk":
        sport = Sport.WALKING.value
        sub_sport = SubSport.GENERIC.value  # Or CASUAL_WALKING
    elif act_type == "Hike":
        sport = Sport.HIKING.value
        sub_sport = SubSport.GENERIC.value
    elif act_type == "Ride":
        sport = Sport.CYCLING.value
        sub_sport = SubSport.ROAD.value  # Default to Road
    elif act_type == "VirtualRide":
        sport = Sport.CYCLING.value
        sub_sport = SubSport.VIRTUAL_ACTIVITY.value
    elif act_type == "GravelRide":
        sport = Sport.CYCLING.value
        sub_sport = SubSport.GRAVEL_CYCLING.value
    elif act_type == "MountainBikeRide":
        sport = Sport.CYCLING.value
        sub_sport = SubSport.MOUNTAIN.value
    elif act_type == "EBikeRide":
        sport = Sport.E_BIKING.value
        sub_sport = SubSport.GENERIC.value
    elif act_type == "Swim":
        sport = Sport.SWIMMING.value
        sub_sport = SubSport.LAP_SWIMMING.value  # Default to Lap Swimming
    elif act_type == "AlpineSki":
        sport = Sport.ALPINE_SKIING.value
        sub_sport = SubSport.RESORT.value
    elif act_type == "BackcountrySki":
        sport = Sport.ALPINE_SKIING.value
        sub_sport = SubSport.BACKCOUNTRY.value
    elif act_type == "Snowboard":
        sport = Sport.SNOWBOARDING.value
        sub_sport = SubSport.GENERIC.value
    # Indoor / Stationary types
    elif act_type == "WeightTraining":
        sport = Sport.TRAINING.value
        sub_sport = SubSport.STRENGTH_TRAINING.value
        is_stationary = True
    elif act_type == "Workout":
        # Strava "Workout" is generic. Could be anything.
        # Often used for Boxing, CrossFit, etc.
        sport = Sport.TRAINING.value
        sub_sport = SubSport.STRENGTH_TRAINING.value  # Changed default from CARDIO to STRENGTH
        is_stationary = True
    elif act_type == "Crossfit":
        sport = Sport.TRAINING.value
        sub_sport = SubSport.CARDIO_TRAINING.value  # No direct Crossfit mapping in SDK 21.60
        is_stationary = True
    elif act_type == "Yoga":
        sport = Sport.TRAINING.value  # Or use Sport.CONNECT if available, but TRAINING is safer
        sub_sport = SubSport.YOGA.value
        is_stationary = True
    elif act_type == "Elliptical":
        sport = Sport.FITNESS_EQUIPMENT.value
        sub_sport = SubSport.ELLIPTICAL.value
        is_stationary = True  # Usually has distance, but GPS is irrelevant.
        # Wait, Elliptical has distance. Should we suppress it?
        # Let's keep distance for Elliptical if provided by machine.
        is_stationary = False
    elif act_type == "StairStepper":
        sport = Sport.FITNESS_EQUIPMENT.value
        sub_sport = SubSport.STAIR_CLIMBING.value
        is_stationary = True  # Distance is usually steps/floors, not meters.
    elif act_type == "RockClimbing":
        sport = Sport.ROCK_CLIMBING.value
        sub_sport = SubSport.GENERIC.value
        # Outdoor climbing has GPS, Indoor doesn't. Hard to distinguish by type alone.
        # Assume Outdoor if GPS present.

    # Special Check for Boxing (if Strava adds it or user uses 'Workout' named Boxing)
    if activity_row.get("name") and "Boxing" in str(activity_row["name"]):
        sport = Sport.BOXING.value  # If SDK supports it (Value 47)
        sub_sport = SubSport.GENERIC.value
        is_stationary = True

    # 2. Records (Track Points)
    if not flyby_df.empty:
        timestamps = [start_date + pd.Timedelta(seconds=int(offset)) for offset in flyby_df["time_offset"]]

        def pace_to_speed(p):
            if pd.isna(p) or p == 0:
                return 0.0
            return (1000.0 / 60.0) / float(p)

        speeds = [pace_to_speed(p) for p in flyby_df["pace"]]

        # Stride Length Calculation
        stride_lengths = []
        cadences = []
        watts = []

        has_cadence = "cadence" in flyby_df.columns
        has_watts = "watts" in flyby_df.columns

        for i in range(len(flyby_df)):
            s = speeds[i]
            c = float(flyby_df["cadence"].iloc[i]) if has_cadence and pd.notna(flyby_df["cadence"].iloc[i]) else 0.0
            w = float(flyby_df["watts"].iloc[i]) if has_watts and pd.notna(flyby_df["watts"].iloc[i]) else None

            cadences.append(c if c > 0 else None)
            watts.append(w)

            if s > 0 and c > 0:
                sl = s / (c / 60.0)
                if 0.2 < sl < 3.0:
                    stride_lengths.append(sl)
                else:
                    stride_lengths.append(None)
            else:
                stride_lengths.append(None)

        record_data = {
            "timestamp": timestamps,
            "position_lat": flyby_df["lat"].astype(float),
            "position_long": flyby_df["lng"].astype(float),
            "distance": flyby_df["distance"].astype(float),
            "altitude": flyby_df["alt"].astype(float),
            "speed": speeds,
            "heart_rate": flyby_df["hr"].astype(float) if "hr" in flyby_df else None,
            "cadence": cadences,
            "power": watts,
            "step_length": stride_lengths,
        }

        # Apply Stationary Logic to Records
        if is_stationary:
            # Clear location, distance, speed, altitude for stationary sports
            # Keep HR, Cadence, Power, Timestamp
            record_data["position_lat"] = [None] * len(timestamps)
            record_data["position_long"] = [None] * len(timestamps)
            record_data["distance"] = [None] * len(timestamps)
            record_data["speed"] = [None] * len(timestamps)
            record_data["altitude"] = [None] * len(timestamps)
            record_data["step_length"] = [None] * len(timestamps)

        fit_record = pd.DataFrame(record_data)
    else:
        fit_record = pd.DataFrame()

    elapsed_time = float(activity_row["elapsed_time"])

    # Session Totals Logic
    total_distance = float(activity_row["distance"])
    avg_speed = float(activity_row["average_speed"])

    if is_stationary:
        total_distance = 0.0
        avg_speed = 0.0

    session_data = {
        "activity_id": [activity_id],
        "timestamp": [start_date + pd.Timedelta(seconds=int(elapsed_time))],
        "start_time": [start_date],
        "total_elapsed_time": [elapsed_time],
        "total_timer_time": [float(activity_row["moving_time"])],
        "total_distance": [total_distance],
        "avg_speed": [avg_speed],
        "avg_heart_rate": [
            float(activity_row["average_heartrate"]) if pd.notna(activity_row["average_heartrate"]) else None
        ],
        "avg_cadence": [None],
        "sport": [sport],
        "sub_sport": [sub_sport],  # Add sub_sport
    }
    fit_session = pd.DataFrame(session_data)

    # 4. Laps
    if is_stationary:
        # User requested to remove Lap messages for indoor/stationary activities
        logger.info("  -> Mode: Stationary (No Laps generated)")
        fit_lap = pd.DataFrame()
    else:
        # Try detailed laps first
        fit_lap = calculate_laps_from_records(fit_record, activity_id, start_date)

        # Fallback to single lap if no detailed laps generated
        if fit_lap is None or fit_lap.empty:
            lap_data = session_data.copy()
            lap_data.pop("sport")
            lap_data.pop("sub_sport")  # Lap doesn't need sub_sport
            fit_lap = pd.DataFrame(lap_data)
            logger.info("  -> Mode: Summary Only (Single Lap created from session totals)")
        else:
            logger.info(f"  -> Mode: Detailed Tracks ({len(fit_lap)} Laps generated)")

    return {"fit_file_id": fit_file_id, "fit_record": fit_record, "fit_session": fit_session, "fit_lap": fit_lap}


def export_fit(activity_id, output_file=None, force=False):
    if not output_file:
        if not os.path.exists(FIT_FOLDER):
            os.makedirs(FIT_FOLDER)
        output_file = os.path.join(FIT_FOLDER, f"{activity_id}.fit")

    logger.info(f"Exporting Activity {activity_id} ...")

    # Optional Sync Logic
    if force:
        logger.info(f"Force sync requested for activity {activity_id}...")
        try:
            env_config = load_env_config()
            if not env_config or not env_config.get("strava_client_id"):
                logger.error("Missing Strava credentials in .env.local. Cannot sync.")
                return

            # Initialize Generator with credentials
            generator = Generator(SQL_FILE)
            generator.set_strava_config(
                env_config["strava_client_id"], env_config["strava_client_secret"], env_config["strava_refresh_token"]
            )

            # Perform sync
            generator.sync_specific_activity(activity_id, force=True)
            if generator.db_connection:
                generator.db_connection.close()
            logger.info("Sync completed.")

        except Exception as e:
            logger.error(f"Sync failed: {e}")
            return

    # 1. Connect & Validate
    try:
        con = get_db_connection(database=SQL_FILE, read_only=True)
    except Exception as e:
        logger.error(f"Error connecting to database: {e}")
        return

    activity_row = validate_activity(con, activity_id)

    if activity_row is None:
        logger.error(f"Activity ID {activity_id} does not exist in the database.")
        return

    logger.info(f"Found Activity: {activity_row['name']} ({activity_row['start_date']})")

    # 2. Fetch Data
    flyby_df = fetch_flyby_data(con, activity_id)
    if flyby_df.empty:
        logger.warning("No GPS/Track data found. FIT file will be summary-only.")
    else:
        logger.info(f"Found {len(flyby_df)} track points.")

    # 3. Construct DataFrames
    dataframes = construct_dataframes(activity_row, flyby_df)

    # 4. Generate FIT File
    logger.info("Building FIT file...")
    try:
        generator = Generator(SQL_FILE)
        fit_bytes = generator.build_fit_file_from_dataframes(dataframes)

        with open(output_file, "wb") as f:
            f.write(fit_bytes)

        logger.info(f"File saved to: {output_file}")
    except Exception as e:
        logger.error(f"Error building FIT file: {e}")
        import traceback

        logger.error(traceback.format_exc())


if __name__ == "__main__":
    from .cli.export_fit import main

    main()

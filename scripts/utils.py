import json
import logging
import sys
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pandas as pd

try:
    from rich import print
except Exception:
    pass
from stravalib.client import Client
from stravalib.exc import RateLimitExceeded


class ActivityJSONEncoder(json.JSONEncoder):
    """Custom JSON encoder to handle pandas Timestamp and other non-serializable types."""

    def default(self, obj):
        if isinstance(obj, pd.Timestamp):
            return obj.isoformat() if pd.notna(obj) else None
        if isinstance(obj, datetime):
            return obj.isoformat()
        if pd.isna(obj):
            return None
        return super().default(obj)


def get_logger(name):
    """
    Creates and configures a logger.
    """
    logger = logging.getLogger(name)
    if not logger.handlers:  # Avoid adding handlers multiple times
        logger.setLevel(logging.INFO)
        handler = logging.StreamHandler(sys.stdout)
        formatter = logging.Formatter("%(asctime)s - %(name)s - %(levelname)s - %(message)s")
        handler.setFormatter(formatter)
        logger.addHandler(handler)
    return logger


def load_env_config():
    env_path = Path(__file__).parent.parent / ".env.local"
    if not env_path.exists():
        return None

    config = {}
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#"):
                key, value = line.split("=", 1)
                config[key.strip()] = value.strip()

    return {
        "strava_client_id": config.get("STRAVA_CLIENT_ID"),
        "strava_client_secret": config.get("STRAVA_CLIENT_SECRET"),
        "strava_refresh_token": config.get("STRAVA_REFRESH_TOKEN"),
        "strava_jwt": config.get("STRAVA_JWT"),
        "garmin_email": config.get("GARMIN_EMAIL"),
        "garmin_password": config.get("GARMIN_PASSWORD"),
        "garmin_is_cn": config.get("GARMIN_IS_CN"),
        "garmin_secret": config.get("GARMIN_SECRET"),
        "garmin_secret_cn": config.get("GARMIN_SECRET_CN"),
    }


def adjust_time(time, tz_name):
    """
    Converts a naive UTC datetime to a naive local datetime.
    """
    try:
        utc_time = time.replace(tzinfo=ZoneInfo("UTC"))
        local_time = utc_time.astimezone(ZoneInfo(tz_name))
        return local_time.replace(tzinfo=None)
    except Exception:
        # Fallback to original time if conversion fails
        return time


def adjust_time_to_utc(time, tz_name):
    """
    Converts a naive local datetime to a naive UTC datetime.
    """
    try:
        tz = ZoneInfo(tz_name)
        tc_offset = time.replace(tzinfo=tz).utcoffset()
        if tc_offset is None:
            return time  # Cannot determine offset for ambiguous time
        return time - tc_offset
    except Exception:
        return time


def adjust_timestamp_to_utc(timestamp, tz_name):
    """
    Converts a local unix timestamp to a UTC unix timestamp.
    """
    try:
        tz = ZoneInfo(tz_name)
        # Create a naive datetime from the local timestamp
        naive_local_dt = datetime.fromtimestamp(timestamp)
        # Determine the offset for that specific datetime
        offset_seconds = naive_local_dt.replace(tzinfo=tz).utcoffset().total_seconds()
        return int(timestamp - offset_seconds)
    except Exception:
        return int(timestamp)


def to_date(ts):
    # TODO use https://docs.python.org/3/library/datetime.html#datetime.datetime.fromisoformat
    # once we decide to move on to python v3.7+
    ts_fmts = ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f"]

    for ts_fmt in ts_fmts:
        try:
            # performance with using exceptions
            # shouldn't be an issue since it's an offline cmdline tool
            return datetime.strptime(ts, ts_fmt)
        except ValueError:
            print(f"Warning: Can not execute strptime {ts} with ts_fmt {ts_fmt},try next one...")
            pass

    raise ValueError(f"cannot parse timestamp {ts} into date with fmts: {ts_fmts}")


def make_activities_file(sql_file, data_dir, json_file, file_suffix="gpx", activity_title_dict={}):
    from generator import Generator

    generator = Generator(sql_file)
    generator.sync_from_data_dir(
        data_dir,
        file_suffix=file_suffix,
        activity_title_dict=activity_title_dict,
    )
    activities_list = generator.load()
    with open(json_file, "w") as f:
        json.dump(activities_list, f, cls=ActivityJSONEncoder)


def make_strava_client(client_id, client_secret, refresh_token):
    client = Client()

    refresh_response = client.refresh_access_token(
        client_id=client_id,
        client_secret=client_secret,
        refresh_token=refresh_token,
    )
    client.access_token = refresh_response["access_token"]
    return client


def get_strava_last_time(client, is_milliseconds=True):
    """
    if there is no activities cause exception return 0
    """
    try:
        activity = None
        activities = client.get_activities(limit=10)
        activities = list(activities)
        activities.sort(key=lambda x: x.start_date, reverse=True)
        # for else in python if you don't know please google it.
        for a in activities:
            if a.type == "Run":
                activity = a
                break
        else:
            return 0
        end_date = activity.start_date + activity.elapsed_time
        last_time = int(datetime.timestamp(end_date))
        if is_milliseconds:
            last_time = last_time * 1000
        return last_time
    except Exception as e:
        print(f"Something wrong to get last time err: {str(e)}")
        return 0


def upload_file_to_strava(client, file_name, data_type, force_to_run=True):
    with open(file_name, "rb") as f:
        try:
            if force_to_run:
                r = client.upload_activity(activity_file=f, data_type=data_type, activity_type="run")
            else:
                r = client.upload_activity(activity_file=f, data_type=data_type)

        except RateLimitExceeded as e:
            timeout = 60.0 if e.timeout is None else float(e.timeout)
            print()
            print(f"Strava API Rate Limit Exceeded. Retry after {timeout} seconds")
            print()
            time.sleep(timeout)
            if force_to_run:
                r = client.upload_activity(activity_file=f, data_type=data_type, activity_type="run")
            else:
                r = client.upload_activity(activity_file=f, data_type=data_type)
        print(f"Uploading {data_type} file: {file_name} to strava, upload_id: {r.upload_id}.")

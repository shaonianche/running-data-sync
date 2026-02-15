import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Optional
from zoneinfo import ZoneInfo

import pandas as pd
from rich.logging import RichHandler
from stravalib.client import Client
from stravalib.exc import RateLimitExceeded

if TYPE_CHECKING:
    from .type_defs import EnvConfig


class ActivityJSONEncoder(json.JSONEncoder):
    """Custom JSON encoder to handle pandas Timestamp and other non-serializable types.

    This encoder ensures strict JSON compliance by:
    - Converting pandas Timestamps to ISO format strings
    - Converting datetime objects to ISO format strings
    - Converting NaN, Infinity, -Infinity floats to null (these are not valid JSON)
    - Converting pandas NA/NaT values to null
    """

    def encode(self, o):
        """Override encode to handle float special values before serialization."""
        return super().encode(self._sanitize(o))

    def iterencode(self, o, _one_shot=False):
        """Override iterencode to handle float special values before serialization."""
        return super().iterencode(self._sanitize(o), _one_shot)

    def _sanitize(self, obj):
        """Recursively sanitize objects, converting non-JSON-compliant values to None."""
        import math

        if isinstance(obj, dict):
            return {k: self._sanitize(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [self._sanitize(item) for item in obj]
        elif isinstance(obj, float):
            # NaN, Infinity, -Infinity are not valid JSON
            if math.isnan(obj) or math.isinf(obj):
                return None
            return obj
        elif obj is pd.NaT:
            # Must check for pandas NaT BEFORE datetime (since NaT is a datetime subclass)
            return None
        elif isinstance(obj, pd.Timestamp):
            return obj.isoformat() if pd.notna(obj) else None
        elif isinstance(obj, datetime):
            return obj.isoformat()
        elif pd.isna(obj):
            return None
        return obj

    def default(self, o):
        if isinstance(o, pd.Timestamp):
            return o.isoformat() if pd.notna(o) else None
        if isinstance(o, datetime):
            return o.isoformat()
        if pd.isna(o):
            return None
        return super().default(o)


class SensitiveFilter(logging.Filter):
    """
    Filter to redact sensitive information from logs.
    """

    def filter(self, record):
        sensitive_keys = {
            "client_id",
            "client_secret",
            "refresh_token",
            "access_token",
            "strava_jwt",
            "garmin_password",
            "garmin_secret",
        }

        def redact_data(data):
            if isinstance(data, dict):
                return {k: ("***" if k in sensitive_keys else redact_data(v)) for k, v in data.items()}
            elif isinstance(data, list):
                return [redact_data(item) for item in data]
            return data

        # Redact args if present
        if record.args:
            if isinstance(record.args, dict):
                record.args = redact_data(record.args)
            elif isinstance(record.args, (list, tuple)):
                record.args = tuple(redact_data(arg) for arg in record.args)

        # Redact message if it contains sensitive keys (handling f-strings or pre-formatted messages)
        if isinstance(record.msg, str):
            import re

            msg = record.msg
            for key in sensitive_keys:
                # Regex to handle 'key': 'value' patterns common in dict string representations
                # Matches: 'client_id': 'value' or 'client_id': "value"
                pattern = f"(['\"]?{key}['\"]?)\\s*:\\s*(['\"])(.*?)\\2"
                msg = re.sub(pattern, r"\1: \2***\2", msg)
            record.msg = msg

        return True


_logging_configured = False


def get_logger(name):
    """
    Creates and configures a logger.
    Configures the root logger with RichHandler if available, ensuring global beautiful output.
    """
    global _logging_configured

    if not _logging_configured:
        root_logger = logging.getLogger()
        # Remove existing handlers to avoid duplicates/conflicts
        if root_logger.handlers:
            for handler in root_logger.handlers[:]:
                root_logger.removeHandler(handler)

        root_logger.setLevel(logging.INFO)

        # RichHandler is the default logging display.
        handler = RichHandler(rich_tracebacks=True, show_time=True, show_path=False)

        # Add the sensitive filter to the handler
        handler.addFilter(SensitiveFilter())

        root_logger.addHandler(handler)
        _logging_configured = True

    return logging.getLogger(name)


logger = get_logger(__name__)


def load_env_config() -> Optional["EnvConfig"]:
    env_path = Path(__file__).parent.parent / ".env.local"
    if not env_path.exists():
        return None

    config: dict[str, str] = {}
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
        "duckdb_encryption_key": config.get("DUCKDB_ENCRYPTION_KEY"),
    }


def adjust_time(time: datetime, tz_name: str) -> datetime:
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


def adjust_time_to_utc(time: datetime, tz_name: str) -> datetime:
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


def adjust_timestamp_to_utc(timestamp: float, tz_name: str) -> int:
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


def to_date(ts: str) -> datetime:
    # TODO use https://docs.python.org/3/library/datetime.html#datetime.datetime.fromisoformat
    # once we decide to move on to python v3.7+
    ts_fmts = ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f"]

    for ts_fmt in ts_fmts:
        try:
            # performance with using exceptions
            # shouldn't be an issue since it's an offline cmdline tool
            return datetime.strptime(ts, ts_fmt)
        except ValueError:
            logger.warning(f"Can not execute strptime {ts} with ts_fmt {ts_fmt}, try next one...")
            pass

    raise ValueError(f"cannot parse timestamp {ts} into date with fmts: {ts_fmts}")


def make_activities_file(
    sql_file: Path,
    data_dir: Path,
    json_file: Path,
    file_suffix: str = "gpx",
    activity_title_dict: Optional[dict[str, str]] = None,
) -> None:
    activity_title_dict = activity_title_dict if activity_title_dict is not None else {}
    from .generator import Generator

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
        logger.error(f"Something wrong to get last time err: {str(e)}")
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
            logger.warning(f"Strava API Rate Limit Exceeded. Retry after {timeout} seconds")
            time.sleep(timeout)
            if force_to_run:
                r = client.upload_activity(activity_file=f, data_type=data_type, activity_type="run")
            else:
                r = client.upload_activity(activity_file=f, data_type=data_type)
        logger.info(f"Uploading {data_type} file: {file_name} to strava, upload_id: {r.upload_id}.")

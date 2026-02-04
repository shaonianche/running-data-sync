from collections import namedtuple
from pathlib import Path
from typing import Final

# Project root directory
PROJECT_ROOT: Final[Path] = Path(__file__).resolve().parent.parent

GPX_FOLDER: Final[Path] = PROJECT_ROOT / "GPX_OUT"
TCX_FOLDER: Final[Path] = PROJECT_ROOT / "TCX_OUT"
FIT_FOLDER: Final[Path] = PROJECT_ROOT / "FIT_OUT"
DB_FOLDER: Final[Path] = PROJECT_ROOT / "public" / "db"
FOLDER_DICT: Final[dict[str, Path]] = {
    "gpx": GPX_FOLDER,
    "tcx": TCX_FOLDER,
    "fit": FIT_FOLDER,
}
SQL_FILE: Final[Path] = PROJECT_ROOT / "scripts" / "data.duckdb"
JSON_FILE: Final[Path] = PROJECT_ROOT / "src" / "static" / "activities.json"
SYNCED_FILE: Final[Path] = PROJECT_ROOT / "imported.json"
SYNCED_ACTIVITY_FILE: Final[Path] = PROJECT_ROOT / "synced_activity.json"

# TODO: Move into nike_sync NRC THINGS


BASE_TIMEZONE: Final[str] = "Asia/Shanghai"
UTC_TIMEZONE: Final[str] = "UTC"

start_point = namedtuple("start_point", "lat lon")
run_map = namedtuple("polyline", "summary_polyline")

# add more type here
STRAVA_GARMIN_TYPE_DICT: Final[dict[str, str]] = {
    "Hike": "hiking",
    "Run": "running",
    "EBikeRide": "cycling",
    "Walk": "walking",
    "Swim": "swimming",
}

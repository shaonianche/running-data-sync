import os
from collections import namedtuple

# getting content root directory
current = os.path.dirname(os.path.realpath(__file__))
parent = os.path.dirname(current)

GPX_FOLDER = os.path.join(parent, "GPX_OUT")
TCX_FOLDER = os.path.join(parent, "TCX_OUT")
FIT_FOLDER = os.path.join(parent, "FIT_OUT")
DB_FOLDER = os.path.join(parent, "public", "db")
FOLDER_DICT = {
    "gpx": GPX_FOLDER,
    "tcx": TCX_FOLDER,
    "fit": FIT_FOLDER,
}
SQL_FILE = os.path.join(parent, "scripts", "data.duckdb")
JSON_FILE = os.path.join(parent, "src", "static", "activities.json")
SYNCED_FILE = os.path.join(parent, "imported.json")
SYNCED_ACTIVITY_FILE = os.path.join(parent, "synced_activity.json")

# TODO: Move into nike_sync NRC THINGS


BASE_TIMEZONE = "Asia/Shanghai"
UTC_TIMEZONE = "UTC"

start_point = namedtuple("start_point", "lat lon")
run_map = namedtuple("polyline", "summary_polyline")

# add more type here
STRAVA_GARMIN_TYPE_DICT = {
    "Hike": "hiking",
    "Run": "running",
    "EBikeRide": "cycling",
    "Walk": "walking",
    "Swim": "swimming",
}

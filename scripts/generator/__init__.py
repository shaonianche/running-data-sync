"""Generator package for activity synchronization and file generation."""

from .db import (
    convert_streams_to_flyby_dataframe,
    get_dataframe_from_strava_activities,
    get_dataframes_for_fit_tables,
    get_db_connection,
    init_db,
    prune_activities_not_in_remote_ids,
    store_flyby_data,
    update_or_create_activities,
    write_fit_dataframes,
)
from .fit_builder import FitBuilderMixin
from .service import Generator
from .strava_client import StravaClientMixin
from .tcx_builder import TcxBuilderMixin

__all__ = [
    # Main class
    "Generator",
    # Mixins
    "FitBuilderMixin",
    "TcxBuilderMixin",
    "StravaClientMixin",
    # DB utilities
    "convert_streams_to_flyby_dataframe",
    "get_dataframe_from_strava_activities",
    "get_dataframes_for_fit_tables",
    "get_db_connection",
    "init_db",
    "prune_activities_not_in_remote_ids",
    "store_flyby_data",
    "update_or_create_activities",
    "write_fit_dataframes",
]

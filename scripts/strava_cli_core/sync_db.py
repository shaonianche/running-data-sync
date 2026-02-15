from ..strava_sync import run_strava_sync
from ..utils import get_logger
from .types import StravaCredentials

logger = get_logger(__name__)


def run_sync_db(credentials: StravaCredentials, *, force: bool = False, prune: bool = False) -> None:
    logger.info("Starting Strava -> DuckDB sync. force=%s prune=%s", force, prune)
    run_strava_sync(
        credentials.client_id,
        credentials.client_secret,
        credentials.refresh_token,
        force_sync=force,
        prune=prune,
    )

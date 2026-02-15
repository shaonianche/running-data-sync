import asyncio
from collections import namedtuple
from datetime import datetime, timezone

import stravalib

from .config import SQL_FILE
from .garmin_sync import Garmin
from .generator import Generator
from .generator.db import get_dataframes_for_fit_tables
from .strava_sync import run_strava_sync
from .utils import get_logger, load_env_config, make_strava_client

logger = get_logger(__name__)
STREAM_FETCH_MAX_RETRIES = 3


async def upload_to_activities(
    garmin_client,
    strava_client,
    use_fake_garmin_device,
    fix_hr,
):
    last_activity = await garmin_client.get_activities(0, 1)
    if not last_activity:
        logger.info("No Garmin activity found. Syncing all Strava activities.")
        filters = {}
    else:
        # is this startTimeGMT must have ?
        after_datetime_str = last_activity[0]["startTimeGMT"]
        after_datetime = datetime.strptime(after_datetime_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        logger.info(f"Last Garmin activity date: {after_datetime}")
        filters = {"after": after_datetime}
    strava_activities = list(strava_client.get_activities(**filters))
    files_list = []
    logger.info(f"Found {len(strava_activities)} new Strava activities to sync.")
    if not strava_activities:
        return files_list

    # a cheap way to init generator
    generator = Generator(SQL_FILE)
    FitFile = namedtuple("FitFile", ["filename", "content"])

    # strava rate limit
    for i in sorted(strava_activities, key=lambda i: int(i.id)):
        logger.info(f"Processing activity: {i.name} ({i.id})")
        stream_types = [
            "time",
            "latlng",
            "altitude",
            "heartrate",
            "cadence",
            "velocity_smooth",
            "distance",
        ]

        streams = None
        for attempt in range(STREAM_FETCH_MAX_RETRIES):
            try:
                streams = strava_client.get_activity_streams(i.id, types=stream_types, resolution="high")
                break
            except stravalib.exc.RateLimitExceeded as ex:
                wait_seconds = float(getattr(ex, "timeout", None) or 60)
                logger.warning(
                    "Strava rate limit when fetching streams for %s, waiting %.1fs (attempt %d/%d).",
                    i.id,
                    wait_seconds,
                    attempt + 1,
                    STREAM_FETCH_MAX_RETRIES,
                )
                await asyncio.sleep(wait_seconds)
            except Exception as ex:
                if attempt == STREAM_FETCH_MAX_RETRIES - 1:
                    logger.error("Failed to fetch streams for activity %s: %s", i.id, ex, exc_info=True)
                else:
                    await asyncio.sleep(2)

        if streams is None:
            continue

        try:
            dataframes = get_dataframes_for_fit_tables(i, streams)
            fit_bytes = generator.build_fit_file_from_dataframes(dataframes)
            file_to_upload = FitFile(filename=f"{i.id}.fit", content=[fit_bytes])
            files_list.append(file_to_upload)
        except Exception as ex:
            logger.error(f"Failed to build FIT for activity {i.id}: {ex}", exc_info=True)
            continue

        # sleep for a while to avoid strava rate limit
        await asyncio.sleep(2)

    await garmin_client.upload_activities_original_from_strava(files_list, use_fake_garmin_device, fix_hr)
    return files_list


async def run_strava_to_garmin_sync(
    client_id: str | None,
    client_secret: str | None,
    refresh_token: str | None,
    secret_string: str | None,
    is_cn: bool,
    use_fake_garmin_device: bool,
    fix_hr: bool,
) -> None:
    if not all([client_id, client_secret, refresh_token]):
        env_config = load_env_config()
        if env_config:
            client_id = client_id or env_config.get("strava_client_id")
            client_secret = client_secret or env_config.get("strava_client_secret")
            refresh_token = refresh_token or env_config.get("strava_refresh_token")

        if not all([client_id, client_secret, refresh_token]):
            raise ValueError("Missing Strava credentials. Please provide them as arguments or in .env.local file")

    strava_client = make_strava_client(
        client_id,
        client_secret,
        refresh_token,
    )

    garmin_auth_domain = "CN" if is_cn else ""
    if not secret_string:
        logger.info("Secret string is not provided, trying to load from env")
        env_config = load_env_config()
        if env_config:
            secret_string = env_config.get("garmin_secret_cn") if is_cn else env_config.get("garmin_secret")

    if not secret_string:
        raise ValueError("Missing garmin secret string")

    garmin_client = Garmin(secret_string, garmin_auth_domain)
    uploaded_files = await upload_to_activities(
        garmin_client,
        strava_client,
        use_fake_garmin_device,
        fix_hr,
    )
    logger.info("Uploaded %d files to Garmin. Starting Strava DB sync.", len(uploaded_files))

    run_strava_sync(
        client_id,
        client_secret,
        refresh_token,
    )


if __name__ == "__main__":
    from .cli.strava_to_garmin_sync import main

    main()

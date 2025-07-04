import argparse
import asyncio
from collections import namedtuple
from datetime import datetime

from config import SQL_FILE
from garmin_sync import Garmin
from generator import Generator
from generator.db import get_dataframes_for_fit_tables
from strava_sync import run_strava_sync

from utils import get_logger, load_env_config, make_strava_client

logger = get_logger(__name__)


async def upload_to_activities(
    garmin_client,
    strava_client,
    use_fake_garmin_device,
):
    last_activity = await garmin_client.get_activities(0, 1)
    if not last_activity:
        logger.info("No Garmin activity found. Syncing all Strava activities.")
        filters = {}
    else:
        # is this startTimeGMT must have ?
        after_datetime_str = last_activity[0]["startTimeGMT"]
        after_datetime = datetime.strptime(after_datetime_str, "%Y-%m-%d %H:%M:%S")
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
        try:
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
            streams = strava_client.get_activity_streams(
                i.id, types=stream_types, resolution="high"
            )

            dataframes = get_dataframes_for_fit_tables(i, streams)
            fit_bytes = generator.build_fit_file_from_dataframes(dataframes)

            file_to_upload = FitFile(filename=f"{i.id}.fit", content=[fit_bytes])
            files_list.append(file_to_upload)

            # sleep for a while to avoid strava rate limit
            await asyncio.sleep(2)
        except Exception as ex:
            logger.error(f"Failed to process activity {i.id}: {ex}", exc_info=True)

    await garmin_client.upload_activities_original_from_strava(
        files_list, use_fake_garmin_device
    )
    return files_list


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--client-id", dest="client_id", help="strava client id")
    parser.add_argument(
        "--client-secret", dest="client_secret", help="strava client secret"
    )
    parser.add_argument(
        "--refresh-token", dest="refresh_token", help="strava refresh token"
    )
    parser.add_argument(
        "secret_string",
        nargs="?",
        help="secret_string from get_garmin_secret.py",
    )
    parser.add_argument(
        "--is-cn",
        dest="is_cn",
        action="store_true",
        help="if garmin account is cn",
    )
    parser.add_argument(
        "--use_fake_garmin_device",
        action="store_true",
        default=False,
        help="whether to use a faked Garmin device",
    )
    options = parser.parse_args()

    # Load Strava credentials from args or .env.local
    client_id = options.client_id
    client_secret = options.client_secret
    refresh_token = options.refresh_token

    if not all([client_id, client_secret, refresh_token]):
        logger.info("Strava credentials not provided via args, trying to load from env")
        env_config = load_env_config()
        if env_config:
            client_id = client_id or env_config.get("strava_client_id")
            client_secret = client_secret or env_config.get("strava_client_secret")
            refresh_token = refresh_token or env_config.get("strava_refresh_token")

    if not all([client_id, client_secret, refresh_token]):
        raise Exception(
            "Missing Strava credentials. "
            "Please provide them as arguments or in .env.local file"
        )

    strava_client = make_strava_client(
        client_id,
        client_secret,
        refresh_token,
    )

    garmin_auth_domain = "CN" if options.is_cn else ""
    secret_string = options.secret_string
    if not secret_string:
        logger.info("Secret string is not provided, trying to load from env")
        env_config = load_env_config()
        if env_config:
            secret_string = (
                env_config.get("garmin_secret_cn")
                if options.is_cn
                else env_config.get("garmin_secret")
            )

    if not secret_string:
        raise Exception("Missing garmin secret string")

    try:
        garmin_client = Garmin(secret_string, garmin_auth_domain)
        await upload_to_activities(
            garmin_client,
            strava_client,
            options.use_fake_garmin_device,
        )
    except Exception as err:
        logger.error(f"An error occurred during the sync process: {err}", exc_info=True)

    # Run the strava sync
    run_strava_sync(
        client_id,
        client_secret,
        refresh_token,
    )


if __name__ == "__main__":
    asyncio.run(main())

import argparse
import json
import os

from config import FIT_FOLDER, JSON_FILE, SQL_FILE, TCX_FOLDER
from generator import Generator

from utils import get_logger, load_env_config


# for only run type, we use the same logic as garmin_sync
def run_strava_sync(
    client_id=None,
    client_secret=None,
    refresh_token=None,
    only_run=False,
    gen_tcx=False,
    is_fit=False,
    force_sync=False,
):
    # Try to load from env if no credentials provided
    if not all([client_id, client_secret, refresh_token]):
        env_config = load_env_config()
        if (
            env_config
            and env_config["strava_client_id"]
            and env_config["strava_client_secret"]
            and env_config["strava_refresh_token"]
        ):
            client_id = env_config["strava_client_id"]
            client_secret = env_config["strava_client_secret"]
            refresh_token = env_config["strava_refresh_token"]
        else:
            raise ValueError("Missing Strava credentials. Please provide them as arguments or in .env.local file")

    logger = get_logger("strava_sync_runner")
    generator = Generator(SQL_FILE)
    generator.set_strava_config(client_id, client_secret, refresh_token)
    generator.only_run = only_run

    if is_fit:
        # Generate FIT files for activities
        logger.info("Running in FIT generation mode.")
        if not os.path.exists(FIT_FOLDER):
            os.makedirs(FIT_FOLDER)
        generator.sync_and_generate_fit(force=force_sync)
    elif gen_tcx:
        if not os.path.exists(TCX_FOLDER):
            os.makedirs(TCX_FOLDER)
        downloaded_ids = [f.split(".")[0] for f in os.listdir(TCX_FOLDER) if f.endswith(".tcx")]
        tcx_files = generator.generate_missing_tcx(downloaded_ids)
        for filename, content in tcx_files:
            with open(os.path.join(TCX_FOLDER, filename), "w") as f:
                f.write(content)
        logger.info(f"Generated {len(tcx_files)} new TCX files.")
    else:
        # Default behavior: sync activities to database
        logger.info("Running in default DB sync mode.")
        generator.sync(force=force_sync)
        activities_list = generator.load()
        with open(JSON_FILE, "w") as f:
            json.dump(activities_list, f)
        logger.info("Default sync finished.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--client-id", dest="client_id", help="strava client id")
    parser.add_argument("--client-secret", dest="client_secret", help="strava client secret")
    parser.add_argument("--refresh-token", dest="refresh_token", help="strava refresh token")
    parser.add_argument(
        "--only-run",
        dest="only_run",
        action="store_true",
        help="if is only for running",
    )
    parser.add_argument(
        "--tcx",
        dest="gen_tcx",
        action="store_true",
        help="generate tcx files",
    )
    parser.add_argument(
        "--fit",
        dest="is_fit",
        action="store_true",
        help="Generate FIT files from Strava streams.",
    )
    parser.add_argument(
        "--force",
        dest="force_sync",
        action="store_true",
        help="Force sync all activities.",
    )
    options = parser.parse_args()
    run_strava_sync(
        options.client_id,
        options.client_secret,
        options.refresh_token,
        only_run=options.only_run,
        gen_tcx=options.gen_tcx,
        is_fit=options.is_fit,
        force_sync=options.force_sync,
    )

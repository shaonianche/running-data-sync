import json
import os

from .config import FIT_FOLDER, JSON_FILE, SQL_FILE, TCX_FOLDER
from .generator import Generator
from .utils import ActivityJSONEncoder, get_logger, load_env_config


# for only run type, we use the same logic as garmin_sync
def run_strava_sync(
    client_id=None,
    client_secret=None,
    refresh_token=None,
    only_run=False,
    gen_tcx=False,
    is_fit=False,
    force_sync=False,
    prune=False,
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
        generator.sync(force=force_sync, prune=prune)
        activities_list = generator.load()
        with open(JSON_FILE, "w") as f:
            json.dump(activities_list, f, cls=ActivityJSONEncoder)
        logger.info("Default sync finished.")


if __name__ == "__main__":
    from .cli.strava_sync import main

    main()

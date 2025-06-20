import argparse
import json

from config import JSON_FILE, SQL_FILE
from generator import Generator

from utils import load_env_config


# for only run type, we use the same logic as garmin_sync
def run_strava_sync(
    client_id=None, client_secret=None, refresh_token=None, only_run=False
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
            raise ValueError(
                "Missing Strava credentials. "
                "Please provide them as arguments or in .env.local file"
            )

    generator = Generator(SQL_FILE)
    generator.set_strava_config(client_id, client_secret, refresh_token)
    generator.only_run = only_run
    generator.sync(False)

    activities_list = generator.load()
    with open(JSON_FILE, "w") as f:
        json.dump(activities_list, f)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--client-id", dest="client_id", help="strava client id"
    )
    parser.add_argument(
        "--client-secret", dest="client_secret", help="strava client secret"
    )
    parser.add_argument(
        "--refresh-token", dest="refresh_token", help="strava refresh token"
    )
    parser.add_argument(
        "--only-run",
        dest="only_run",
        action="store_true",
        help="if is only for running",
    )
    options = parser.parse_args()
    run_strava_sync(
        options.client_id,
        options.client_secret,
        options.refresh_token,
        only_run=options.only_run,
    )

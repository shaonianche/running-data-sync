import argparse
import asyncio

from ..strava_to_garmin_sync import run_strava_to_garmin_sync


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--client-id", dest="client_id", help="strava client id")
    parser.add_argument("--client-secret", dest="client_secret", help="strava client secret")
    parser.add_argument("--refresh-token", dest="refresh_token", help="strava refresh token")
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
        "--use-fake-garmin-device",
        dest="use_fake_garmin_device",
        action="store_true",
        default=False,
        help="whether to use a faked Garmin device",
    )
    parser.add_argument(
        "--fix-hr",
        dest="fix_hr",
        action="store_true",
        help="fix heart rate in fit file",
    )
    return parser


def main() -> None:
    parser = build_parser()
    options = parser.parse_args()
    asyncio.run(
        run_strava_to_garmin_sync(
            options.client_id,
            options.client_secret,
            options.refresh_token,
            options.secret_string,
            options.is_cn,
            options.use_fake_garmin_device,
            options.fix_hr,
        )
    )


if __name__ == "__main__":
    main()

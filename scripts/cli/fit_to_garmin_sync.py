import argparse
import asyncio

from ..fit_to_garmin_sync import run_fit_to_garmin_sync


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("secret_string", nargs="?", help="secret_string from get_garmin_secret.py")
    parser.add_argument(
        "--is-cn",
        dest="is_cn",
        action="store_true",
        help="if garmin account is cn",
    )
    return parser


def main() -> None:
    parser = build_parser()
    options = parser.parse_args()
    asyncio.run(run_fit_to_garmin_sync(options.secret_string, options.is_cn))


if __name__ == "__main__":
    main()

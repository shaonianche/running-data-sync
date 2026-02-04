import argparse
import asyncio

from ..garmin_sync import run_garmin_sync


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "secret_string",
        nargs="?",
        help="secret_string from get_garmin_secret.py or .env.local",
    )
    parser.add_argument(
        "--is-cn",
        dest="is_cn",
        action="store_true",
        help="if garmin account is cn",
    )
    parser.add_argument(
        "--only-run",
        dest="only_run",
        action="store_true",
        help="if is only for running",
    )
    parser.add_argument(
        "--tcx",
        dest="download_file_type",
        action="store_const",
        const="tcx",
        default="gpx",
        help="to download tcx files",
    )
    parser.add_argument(
        "--fit",
        dest="download_file_type",
        action="store_const",
        const="fit",
        default="gpx",
        help="to download fit files",
    )
    return parser


def main() -> None:
    parser = build_parser()
    options = parser.parse_args()
    asyncio.run(
        run_garmin_sync(
            options.secret_string,
            options.is_cn,
            options.only_run,
            options.download_file_type,
        )
    )


if __name__ == "__main__":
    main()

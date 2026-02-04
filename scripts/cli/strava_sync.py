import argparse

from ..strava_sync import run_strava_sync


def build_parser() -> argparse.ArgumentParser:
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
    return parser


def main() -> None:
    parser = build_parser()
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


if __name__ == "__main__":
    main()

import argparse

from ..export_fit import export_fit


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Export FIT file from DuckDB activity data")
    parser.add_argument("activity_id", type=int, help="Activity ID (run_id)")
    parser.add_argument("--output", "-o", help="Output file path")
    parser.add_argument("--force", action="store_true", help="Force sync from Strava before exporting")
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    export_fit(args.activity_id, args.output, args.force)


if __name__ == "__main__":
    main()

import argparse

from ..save_to_parquet import export_parquet


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--tables",
        nargs="*",
        default=None,
        help="Optional list of table names to export (defaults to activities, activities_flyby).",
    )
    return parser


def main() -> None:
    parser = build_parser()
    options = parser.parse_args()
    export_parquet(options.tables)


if __name__ == "__main__":
    main()

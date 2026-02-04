import argparse
import sys

from ..get_garmin_secret import get_garmin_secret


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("email", nargs="?", help="email of garmin")
    parser.add_argument("password", nargs="?", help="password of garmin")
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
    try:
        secret_string = get_garmin_secret(
            options.email,
            options.password,
            is_cn=options.is_cn,
        )
        print(secret_string)
    except ValueError as e:
        print(str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()

import sys

from ..gpxtrackposter.exceptions import PosterError
from ..gen_svg import main


def cli_main() -> None:
    try:
        main()
    except PosterError as e:
        print(str(e))
        sys.exit(1)


if __name__ == "__main__":
    cli_main()

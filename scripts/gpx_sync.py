"""
If you do not want bind any account
Only the gpx files in GPX_OUT sync
"""

from .config import GPX_FOLDER, JSON_FILE, SQL_FILE

from .utils import make_activities_file

def run_gpx_sync() -> None:
    print("only sync gpx files in GPX_OUT")
    make_activities_file(SQL_FILE, GPX_FOLDER, JSON_FILE)


if __name__ == "__main__":
    from .cli.gpx_sync import main

    main()

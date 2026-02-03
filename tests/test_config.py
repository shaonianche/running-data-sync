"""Tests for config.py module."""

import os
from pathlib import Path


class TestConfig:
    """Test cases for config module."""

    def test_output_dir_exists(self):
        """Test that OUTPUT_DIR path is properly defined."""
        from config import OUTPUT_DIR

        assert OUTPUT_DIR is not None
        assert isinstance(OUTPUT_DIR, str)
        assert "activities" in OUTPUT_DIR

    def test_gpx_folder_exists(self):
        """Test that GPX_FOLDER path is properly defined."""
        from config import GPX_FOLDER

        assert GPX_FOLDER is not None
        assert isinstance(GPX_FOLDER, str)
        assert "GPX_OUT" in GPX_FOLDER

    def test_tcx_folder_exists(self):
        """Test that TCX_FOLDER path is properly defined."""
        from config import TCX_FOLDER

        assert TCX_FOLDER is not None
        assert isinstance(TCX_FOLDER, str)
        assert "TCX_OUT" in TCX_FOLDER

    def test_fit_folder_exists(self):
        """Test that FIT_FOLDER path is properly defined."""
        from config import FIT_FOLDER

        assert FIT_FOLDER is not None
        assert isinstance(FIT_FOLDER, str)
        assert "FIT_OUT" in FIT_FOLDER

    def test_folder_dict_contains_all_formats(self):
        """Test that FOLDER_DICT contains gpx, tcx, and fit keys."""
        from config import FOLDER_DICT

        assert "gpx" in FOLDER_DICT
        assert "tcx" in FOLDER_DICT
        assert "fit" in FOLDER_DICT

    def test_sql_file_path(self):
        """Test that SQL_FILE path is properly defined."""
        from config import SQL_FILE

        assert SQL_FILE is not None
        assert SQL_FILE.endswith(".duckdb")

    def test_timezone_constants(self):
        """Test that timezone constants are properly defined."""
        from config import BASE_TIMEZONE, UTC_TIMEZONE

        assert BASE_TIMEZONE == "Asia/Shanghai"
        assert UTC_TIMEZONE == "UTC"

    def test_strava_garmin_type_dict(self):
        """Test that STRAVA_GARMIN_TYPE_DICT contains expected mappings."""
        from config import STRAVA_GARMIN_TYPE_DICT

        assert "Hike" in STRAVA_GARMIN_TYPE_DICT
        assert STRAVA_GARMIN_TYPE_DICT["Hike"] == "hiking"
        assert "Run" in STRAVA_GARMIN_TYPE_DICT
        assert STRAVA_GARMIN_TYPE_DICT["Run"] == "running"
        assert "Walk" in STRAVA_GARMIN_TYPE_DICT
        assert STRAVA_GARMIN_TYPE_DICT["Walk"] == "walking"

    def test_namedtuples_defined(self):
        """Test that namedtuples are properly defined."""
        from config import run_map, start_point

        # Test start_point namedtuple
        sp = start_point(lat=39.9, lon=116.4)
        assert sp.lat == 39.9
        assert sp.lon == 116.4

        # Test run_map namedtuple
        rm = run_map(summary_polyline="abc123")
        assert rm.summary_polyline == "abc123"

    def test_paths_are_absolute(self):
        """Test that all path constants are absolute paths."""
        from config import (
            DB_FOLDER,
            FIT_FOLDER,
            GPX_FOLDER,
            JSON_FILE,
            OUTPUT_DIR,
            SQL_FILE,
            TCX_FOLDER,
        )

        paths = [OUTPUT_DIR, GPX_FOLDER, TCX_FOLDER, FIT_FOLDER, DB_FOLDER, SQL_FILE, JSON_FILE]

        for path in paths:
            assert os.path.isabs(path), f"Path {path} should be absolute"

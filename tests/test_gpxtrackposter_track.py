"""Tests for gpxtrackposter/track.py module."""

import datetime
import os
from unittest.mock import MagicMock, patch

import pytest


class TestTrackInit:
    """Test cases for Track class initialization."""

    def test_track_default_values(self):
        """Test that Track initializes with default values."""
        from scripts.gpxtrackposter.track import Track

        track = Track()

        assert track.file_names == []
        assert track.polylines == []
        assert track.polyline_str == ""
        assert track.track_name is None
        assert track.start_time is None
        assert track.end_time is None
        assert track.length == 0
        assert track.special is False
        assert track.average_heartrate is None
        assert track.type == "Run"

    def test_track_has_moving_dict(self):
        """Test that Track has an empty moving_dict."""
        from scripts.gpxtrackposter.track import Track

        track = Track()

        assert track.moving_dict == {}


class TestTrackBbox:
    """Test cases for Track.bbox method."""

    def test_bbox_empty_polylines(self):
        """Test bbox with empty polylines."""
        import s2sphere as s2

        from scripts.gpxtrackposter.track import Track

        track = Track()
        bbox = track.bbox()

        assert isinstance(bbox, s2.LatLngRect)

    def test_bbox_with_polylines(self):
        """Test bbox with polylines."""
        import s2sphere as s2

        from scripts.gpxtrackposter.track import Track

        track = Track()
        track.polylines = [
            [
                s2.LatLng.from_degrees(39.9000, 116.4000),
                s2.LatLng.from_degrees(39.9100, 116.4100),
            ]
        ]

        bbox = track.bbox()

        assert not bbox.is_empty()
        assert bbox.lat_lo().degrees <= 39.9000
        assert bbox.lat_hi().degrees >= 39.9100


class TestTrackMakeRunId:
    """Test cases for Track.__make_run_id method."""

    def test_make_run_id(self):
        """Test that run_id is created from timestamp."""
        from scripts.gpxtrackposter.track import Track

        # Access the private method through name mangling
        timestamp = datetime.datetime(2024, 1, 15, 10, 30, 0)
        run_id = Track._Track__make_run_id(timestamp)

        assert isinstance(run_id, int)
        assert run_id > 0


class TestTrackLoadGpx:
    """Test cases for Track.load_gpx method."""

    def test_load_gpx_empty_file(self, temp_dir):
        """Test loading an empty GPX file raises TrackLoadError."""
        from scripts.gpxtrackposter.exceptions import TrackLoadError
        from scripts.gpxtrackposter.track import Track

        # Create empty file
        gpx_file = temp_dir / "empty.gpx"
        gpx_file.write_text("")

        track = Track()
        with pytest.raises(TrackLoadError, match="Empty GPX file"):
            track.load_gpx(str(gpx_file))

    def test_load_gpx_valid_file(self, temp_dir, sample_gpx_content):
        """Test loading a valid GPX file."""
        from scripts.gpxtrackposter.track import Track

        gpx_file = temp_dir / "test.gpx"
        gpx_file.write_text(sample_gpx_content)

        track = Track()
        track.load_gpx(str(gpx_file))

        assert "test.gpx" in track.file_names

    def test_load_gpx_nonexistent_file(self):
        """Test loading a non-existent GPX file raises TrackLoadError."""
        from scripts.gpxtrackposter.exceptions import TrackLoadError
        from scripts.gpxtrackposter.track import Track

        track = Track()
        with pytest.raises(TrackLoadError, match="Cannot read GPX file"):
            track.load_gpx("/nonexistent/path/file.gpx")


class TestTrackLoadTcx:
    """Test cases for Track.load_tcx method."""

    def test_load_tcx_empty_file(self, temp_dir):
        """Test loading an empty TCX file raises TrackLoadError."""
        from scripts.gpxtrackposter.exceptions import TrackLoadError
        from scripts.gpxtrackposter.track import Track

        tcx_file = temp_dir / "empty.tcx"
        tcx_file.write_text("")

        track = Track()
        with pytest.raises(TrackLoadError, match="Empty TCX file"):
            track.load_tcx(str(tcx_file))


class TestTrackLoadFit:
    """Test cases for Track.load_fit method."""

    def test_load_fit_empty_file(self, temp_dir):
        """Test loading an empty FIT file raises TrackLoadError."""
        from scripts.gpxtrackposter.exceptions import TrackLoadError
        from scripts.gpxtrackposter.track import Track

        fit_file = temp_dir / "empty.fit"
        fit_file.write_text("")

        track = Track()
        with pytest.raises(TrackLoadError, match="Empty FIT file"):
            track.load_fit(str(fit_file))


class TestTrackLoadFromDb:
    """Test cases for Track.load_from_db method."""

    def test_load_from_db_with_polyline(self):
        """Test loading track from database activity with polyline."""
        from scripts.gpxtrackposter.track import Track

        # Create mock activity
        activity = MagicMock()
        activity.run_id = 1234567890
        activity.start_date_local = "2024-01-15 10:30:00"
        activity.elapsed_time = 1800
        activity.distance = 5000.0
        activity.summary_polyline = "o}zcFwxjqU"  # Simple encoded polyline

        with patch.dict(os.environ, {"IGNORE_BEFORE_SAVING": ""}):
            track = Track()
            track.load_from_db(activity)

            assert track.run_id == 1234567890
            assert track.length == 5000.0

    def test_load_from_db_without_polyline(self):
        """Test loading track from database activity without polyline."""
        from scripts.gpxtrackposter.track import Track

        activity = MagicMock()
        activity.run_id = 1234567890
        activity.start_date_local = "2024-01-15 10:30:00"
        activity.elapsed_time = 1800
        activity.distance = 5000.0
        activity.summary_polyline = None

        track = Track()
        track.load_from_db(activity)

        assert track.run_id == 1234567890
        assert track.polylines == [[]]

    def test_load_from_db_with_empty_string_polyline(self):
        """Test loading track from database with empty string polyline."""
        from scripts.gpxtrackposter.track import Track

        activity = MagicMock()
        activity.run_id = 1234567890
        activity.start_date_local = "2024-01-15 10:30:00"
        activity.elapsed_time = 1800
        activity.distance = 5000.0
        activity.summary_polyline = ""

        track = Track()
        track.load_from_db(activity)

        assert track.polylines == [[]]


class TestTrackAppend:
    """Test cases for Track.append method."""

    def test_append_tracks(self):
        """Test appending two tracks."""
        from scripts.gpxtrackposter.track import Track

        track1 = Track()
        track1.file_names = ["file1.gpx"]
        track1.length = 5000
        track1.end_time = datetime.datetime(2024, 1, 15, 11, 0, 0)
        track1.moving_dict = {
            "distance": 5000,
            "moving_time": datetime.timedelta(seconds=1800),
            "elapsed_time": datetime.timedelta(seconds=1800),
            "average_speed": 2.78,
        }
        track1.polyline_container = [(39.9, 116.4)]

        track2 = Track()
        track2.file_names = ["file2.gpx"]
        track2.length = 3000
        track2.end_time = datetime.datetime(2024, 1, 15, 12, 0, 0)
        track2.moving_dict = {
            "distance": 3000,
            "moving_time": datetime.timedelta(seconds=1200),
            "elapsed_time": datetime.timedelta(seconds=1200),
            "average_speed": 2.5,
        }
        track2.polyline_container = [(39.91, 116.41)]
        track2.elevation_gain = 50

        track1.append(track2)

        assert track1.length == 8000
        assert track1.end_time == datetime.datetime(2024, 1, 15, 12, 0, 0)
        assert "file2.gpx" in track1.file_names


class TestTrackToNamedtuple:
    """Test cases for Track.to_namedtuple method."""

    def test_to_namedtuple(self):
        """Test converting track to namedtuple."""
        from scripts.gpxtrackposter.track import Track

        track = Track()
        track.run_id = 1234567890
        track.track_name = "Morning Run"
        track.type = "Run"
        track.subtype = None
        track.start_time = datetime.datetime(2024, 1, 15, 10, 30, 0)
        track.end_time = datetime.datetime(2024, 1, 15, 11, 0, 0)
        track.start_time_local = datetime.datetime(2024, 1, 15, 18, 30, 0)
        track.end_time_local = datetime.datetime(2024, 1, 15, 19, 0, 0)
        track.length = 5000
        track.average_heartrate = 145
        track.elevation_gain = 50
        track.polyline_str = "abc123"
        track.start_latlng = (39.9, 116.4)
        track.moving_dict = {
            "distance": 5000,
            "moving_time": datetime.timedelta(seconds=1800),
            "elapsed_time": datetime.timedelta(seconds=1800),
            "average_speed": 2.78,
        }

        result = track.to_namedtuple()

        assert result.id == 1234567890
        assert result.name == "Morning Run"
        assert result.type == "Run"
        assert result.length == 5000
        assert result.average_heartrate == 145

    def test_to_namedtuple_no_name(self):
        """Test converting track without name to namedtuple."""
        from scripts.gpxtrackposter.track import Track

        track = Track()
        track.run_id = 1234567890
        track.track_name = None
        track.type = "Run"
        track.start_time = datetime.datetime(2024, 1, 15, 10, 30, 0)
        track.end_time = datetime.datetime(2024, 1, 15, 11, 0, 0)
        track.start_time_local = datetime.datetime(2024, 1, 15, 18, 30, 0)
        track.end_time_local = datetime.datetime(2024, 1, 15, 19, 0, 0)
        track.length = 5000
        track.polyline_str = ""
        track.start_latlng = []
        track.moving_dict = {}

        result = track.to_namedtuple()

        assert result.name == ""


class TestSemicircleConstant:
    """Test cases for SEMICIRCLE constant."""

    def test_semicircle_value(self):
        """Test that SEMICIRCLE constant is correct."""
        from scripts.gpxtrackposter.track import SEMICIRCLE

        # 2^32 / 360 = 11930464.711...
        expected = 11930465
        assert SEMICIRCLE == expected

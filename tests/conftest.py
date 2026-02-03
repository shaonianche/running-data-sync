"""Pytest configuration and shared fixtures."""

import os
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import MagicMock

import pytest

# Add scripts directory to path for imports
scripts_dir = Path(__file__).parent.parent / "scripts"
sys.path.insert(0, str(scripts_dir))


@pytest.fixture
def temp_dir():
    """Create a temporary directory for test files."""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield Path(tmpdir)


@pytest.fixture
def sample_polyline_coords():
    """Sample polyline coordinates for testing."""
    return [
        (39.9042, 116.4074),  # Beijing
        (39.9050, 116.4080),
        (39.9060, 116.4090),
        (39.9070, 116.4100),
        (39.9080, 116.4110),
    ]


@pytest.fixture
def sample_datetime():
    """Sample datetime for testing."""
    return datetime(2024, 1, 15, 10, 30, 0)


@pytest.fixture
def sample_activity_data():
    """Sample activity data for testing."""
    return {
        "run_id": 1234567890,
        "name": "Morning Run",
        "distance": 5000.0,
        "moving_time": 1800,
        "elapsed_time": 1850,
        "type": "Run",
        "start_date": "2024-01-15 10:30:00",
        "start_date_local": "2024-01-15 18:30:00",
        "summary_polyline": "o}zcFwxjqU",
        "average_heartrate": 145,
        "elevation_gain": 50,
    }


@pytest.fixture
def mock_env_file(temp_dir):
    """Create a mock .env.local file."""
    env_content = """
STRAVA_CLIENT_ID=12345
STRAVA_CLIENT_SECRET=secret123
STRAVA_REFRESH_TOKEN=refresh123
GARMIN_EMAIL=test@example.com
GARMIN_PASSWORD=password123
"""
    env_file = temp_dir / ".env.local"
    env_file.write_text(env_content)
    return env_file


@pytest.fixture
def sample_gpx_content():
    """Sample GPX file content for testing."""
    return """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test">
  <trk>
    <name>Test Run</name>
    <type>running</type>
    <trkseg>
      <trkpt lat="39.9042" lon="116.4074">
        <time>2024-01-15T10:30:00Z</time>
      </trkpt>
      <trkpt lat="39.9050" lon="116.4080">
        <time>2024-01-15T10:31:00Z</time>
      </trkpt>
      <trkpt lat="39.9060" lon="116.4090">
        <time>2024-01-15T10:32:00Z</time>
      </trkpt>
    </trkseg>
  </trk>
</gpx>
"""

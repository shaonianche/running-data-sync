"""Tests for generator/db.py module."""

import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import duckdb
import pandas as pd
import pytest


class TestDatabaseSchemas:
    """Test cases for database schema definitions."""

    def test_activities_schema_has_required_columns(self):
        """Test that ACTIVITIES_SCHEMA has all required columns."""
        from generator.db import ACTIVITIES_SCHEMA

        required_columns = [
            "run_id",
            "name",
            "distance",
            "moving_time",
            "elapsed_time",
            "type",
            "start_date",
            "start_date_local",
            "summary_polyline",
        ]

        for col in required_columns:
            assert col in ACTIVITIES_SCHEMA, f"Missing column: {col}"

    def test_activities_schema_run_id_is_primary_key(self):
        """Test that run_id is the primary key."""
        from generator.db import ACTIVITIES_SCHEMA

        assert "PRIMARY KEY" in ACTIVITIES_SCHEMA["run_id"]

    def test_activities_flyby_schema_has_required_columns(self):
        """Test that ACTIVITIES_FLYBY_SCHEMA has all required columns."""
        from generator.db import ACTIVITIES_FLYBY_SCHEMA

        required_columns = ["activity_id", "time_offset", "lat", "lng", "hr", "pace"]

        for col in required_columns:
            assert col in ACTIVITIES_FLYBY_SCHEMA, f"Missing column: {col}"

    def test_fit_file_id_schema_exists(self):
        """Test that FIT_FILE_ID_SCHEMA is defined."""
        from generator.db import FIT_FILE_ID_SCHEMA

        assert "serial_number" in FIT_FILE_ID_SCHEMA
        assert "PRIMARY KEY" in FIT_FILE_ID_SCHEMA["serial_number"]

    def test_fit_record_schema_exists(self):
        """Test that FIT_RECORD_SCHEMA is defined."""
        from generator.db import FIT_RECORD_SCHEMA

        required_columns = ["activity_id", "timestamp", "position_lat", "position_long"]
        for col in required_columns:
            assert col in FIT_RECORD_SCHEMA

    def test_fit_lap_schema_exists(self):
        """Test that FIT_LAP_SCHEMA is defined."""
        from generator.db import FIT_LAP_SCHEMA

        assert "activity_id" in FIT_LAP_SCHEMA
        assert "total_distance" in FIT_LAP_SCHEMA

    def test_fit_session_schema_exists(self):
        """Test that FIT_SESSION_SCHEMA is defined."""
        from generator.db import FIT_SESSION_SCHEMA

        assert "activity_id" in FIT_SESSION_SCHEMA
        assert "PRIMARY KEY" in FIT_SESSION_SCHEMA["activity_id"]


class TestCreateTableIfNotExists:
    """Test cases for _create_table_if_not_exists function."""

    def test_create_table_simple_schema(self, temp_dir):
        """Test creating a table with a simple schema."""
        from generator.db import _create_table_if_not_exists

        db_path = temp_dir / "test.duckdb"
        con = duckdb.connect(str(db_path))

        schema = {"id": "INTEGER PRIMARY KEY", "name": "VARCHAR", "value": "DOUBLE"}

        _create_table_if_not_exists(con, "test_table", schema)

        # Verify table was created
        result = con.execute("SELECT count(*) FROM test_table").fetchone()
        assert result[0] == 0

        con.close()

    def test_create_table_idempotent(self, temp_dir):
        """Test that creating the same table twice is safe."""
        from generator.db import _create_table_if_not_exists

        db_path = temp_dir / "test.duckdb"
        con = duckdb.connect(str(db_path))

        schema = {"id": "INTEGER PRIMARY KEY"}

        _create_table_if_not_exists(con, "test_table", schema)
        _create_table_if_not_exists(con, "test_table", schema)

        # Should not raise an exception
        result = con.execute("SELECT count(*) FROM test_table").fetchone()
        assert result[0] == 0

        con.close()


class TestInitDb:
    """Test cases for init_db function."""

    def test_init_db_creates_tables(self, temp_dir):
        """Test that init_db creates the required tables."""
        from generator.db import init_db

        db_path = temp_dir / "test.duckdb"
        con = init_db(str(db_path))

        # Check that activities table exists
        tables = con.execute("SHOW TABLES").fetchall()
        table_names = [t[0] for t in tables]

        assert "activities" in table_names
        assert "activities_flyby" in table_names

        con.close()

    def test_init_db_returns_connection(self, temp_dir):
        """Test that init_db returns a valid connection."""
        from generator.db import init_db

        db_path = temp_dir / "test.duckdb"
        con = init_db(str(db_path))

        assert con is not None
        # Should be able to execute queries
        result = con.execute("SELECT 1").fetchone()
        assert result[0] == 1

        con.close()


class TestUpdateOrCreateActivities:
    """Test cases for update_or_create_activities function."""

    def test_insert_new_activities(self, temp_dir):
        """Test inserting new activities."""
        from generator.db import ACTIVITIES_SCHEMA, init_db, update_or_create_activities

        db_path = temp_dir / "test.duckdb"
        con = init_db(str(db_path))

        # Create test data with ALL columns from the schema
        activities_df = pd.DataFrame(
            {
                "run_id": [1, 2, 3],
                "name": ["Run 1", "Run 2", "Run 3"],
                "distance": [5000.0, 10000.0, 7500.0],
                "moving_time": [1800, 3600, 2700],
                "elapsed_time": [1850, 3700, 2800],
                "type": ["Run", "Run", "Run"],
                "subtype": [None, None, None],
                "start_date": pd.to_datetime(["2024-01-15", "2024-01-16", "2024-01-17"]),
                "start_date_local": pd.to_datetime(["2024-01-15", "2024-01-16", "2024-01-17"]),
                "location_country": [None, None, None],
                "summary_polyline": [None, None, None],
                "average_heartrate": [145.0, 150.0, 148.0],
                "average_speed": [2.78, 2.78, 2.78],
                "elevation_gain": [50.0, 100.0, 75.0],
            }
        )

        count = update_or_create_activities(con, activities_df)

        assert count == 3

        # Verify data was inserted
        result = con.execute("SELECT count(*) FROM activities").fetchone()
        assert result[0] == 3

        con.close()

    def test_update_existing_activities(self, temp_dir):
        """Test updating existing activities."""
        from generator.db import init_db, update_or_create_activities

        db_path = temp_dir / "test.duckdb"
        con = init_db(str(db_path))

        # Insert initial data with ALL columns
        initial_df = pd.DataFrame(
            {
                "run_id": [1],
                "name": ["Original Run"],
                "distance": [5000.0],
                "moving_time": [1800],
                "elapsed_time": [1850],
                "type": ["Run"],
                "subtype": [None],
                "start_date": pd.to_datetime(["2024-01-15"]),
                "start_date_local": pd.to_datetime(["2024-01-15"]),
                "location_country": [None],
                "summary_polyline": [None],
                "average_heartrate": [145.0],
                "average_speed": [2.78],
                "elevation_gain": [50.0],
            }
        )
        update_or_create_activities(con, initial_df)

        # Update with new data
        updated_df = pd.DataFrame(
            {
                "run_id": [1],
                "name": ["Updated Run"],
                "distance": [6000.0],
                "moving_time": [2000],
                "elapsed_time": [2050],
                "type": ["Run"],
                "subtype": [None],
                "start_date": pd.to_datetime(["2024-01-15"]),
                "start_date_local": pd.to_datetime(["2024-01-15"]),
                "location_country": [None],
                "summary_polyline": [None],
                "average_heartrate": [150.0],
                "average_speed": [3.0],
                "elevation_gain": [60.0],
            }
        )
        update_or_create_activities(con, updated_df)

        # Verify data was updated
        result = con.execute("SELECT name, distance FROM activities WHERE run_id = 1").fetchone()
        assert result[0] == "Updated Run"
        assert result[1] == 6000.0

        con.close()

    def test_empty_dataframe(self, temp_dir):
        """Test with empty DataFrame."""
        from generator.db import init_db, update_or_create_activities

        db_path = temp_dir / "test.duckdb"
        con = init_db(str(db_path))

        empty_df = pd.DataFrame()
        count = update_or_create_activities(con, empty_df)

        assert count == 0

        con.close()


class TestMigrateSchema:
    """Test cases for _migrate_schema function."""

    def test_migrate_schema_adds_missing_columns(self, temp_dir):
        """Test that migration adds missing columns."""
        from generator.db import ACTIVITIES_SCHEMA, _migrate_schema

        db_path = temp_dir / "test.duckdb"
        con = duckdb.connect(str(db_path))

        # Create table with minimal columns
        con.execute("CREATE TABLE activities (run_id BIGINT PRIMARY KEY, name VARCHAR)")

        # Run migration
        _migrate_schema(con)

        # Check that columns were added
        columns = con.execute("PRAGMA table_info('activities')").fetchdf()
        column_names = set(columns["name"])

        # Should have more columns now
        assert len(column_names) > 2

        con.close()

    def test_migrate_schema_no_op_if_complete(self, temp_dir):
        """Test that migration does nothing if schema is complete."""
        from generator.db import init_db

        db_path = temp_dir / "test.duckdb"

        # First init creates complete schema
        con = init_db(str(db_path))
        con.close()

        # Second init should not fail
        con = init_db(str(db_path))
        con.close()


class TestGeocoding:
    """Test cases for geocoding functionality."""

    def test_geocode_cache_exists(self):
        """Test that geocode cache is initialized."""
        from generator.db import _geocode_cache

        assert isinstance(_geocode_cache, dict)

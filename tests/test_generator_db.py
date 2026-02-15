"""Tests for generator/db.py module."""

from unittest.mock import patch

import duckdb
import pandas as pd


class TestDatabaseSchemas:
    """Test cases for database schema definitions."""

    def test_activities_schema_has_required_columns(self):
        """Test that ACTIVITIES_SCHEMA has all required columns."""
        from scripts.generator.db import ACTIVITIES_SCHEMA

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
        from scripts.generator.db import ACTIVITIES_SCHEMA

        assert "PRIMARY KEY" in ACTIVITIES_SCHEMA["run_id"]

    def test_activities_flyby_schema_has_required_columns(self):
        """Test that ACTIVITIES_FLYBY_SCHEMA has all required columns."""
        from scripts.generator.db import ACTIVITIES_FLYBY_SCHEMA

        required_columns = ["activity_id", "time_offset", "lat", "lng", "hr", "pace"]

        for col in required_columns:
            assert col in ACTIVITIES_FLYBY_SCHEMA, f"Missing column: {col}"

    def test_fit_file_id_schema_exists(self):
        """Test that FIT_FILE_ID_SCHEMA is defined."""
        from scripts.generator.db import FIT_FILE_ID_SCHEMA

        assert "serial_number" in FIT_FILE_ID_SCHEMA
        assert "PRIMARY KEY" in FIT_FILE_ID_SCHEMA["serial_number"]

    def test_fit_record_schema_exists(self):
        """Test that FIT_RECORD_SCHEMA is defined."""
        from scripts.generator.db import FIT_RECORD_SCHEMA

        required_columns = ["activity_id", "timestamp", "position_lat", "position_long"]
        for col in required_columns:
            assert col in FIT_RECORD_SCHEMA

    def test_fit_lap_schema_exists(self):
        """Test that FIT_LAP_SCHEMA is defined."""
        from scripts.generator.db import FIT_LAP_SCHEMA

        assert "activity_id" in FIT_LAP_SCHEMA
        assert "total_distance" in FIT_LAP_SCHEMA

    def test_fit_session_schema_exists(self):
        """Test that FIT_SESSION_SCHEMA is defined."""
        from scripts.generator.db import FIT_SESSION_SCHEMA

        assert "activity_id" in FIT_SESSION_SCHEMA
        assert "PRIMARY KEY" in FIT_SESSION_SCHEMA["activity_id"]


class TestCreateTableIfNotExists:
    """Test cases for _create_table_if_not_exists function."""

    def test_create_table_simple_schema(self, temp_dir):
        """Test creating a table with a simple schema."""
        from scripts.generator.db import _create_table_if_not_exists

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
        from scripts.generator.db import _create_table_if_not_exists

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
        from scripts.generator.db import init_db

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
        from scripts.generator.db import init_db

        db_path = temp_dir / "test.duckdb"
        con = init_db(str(db_path))

        assert con is not None
        # Should be able to execute queries
        result = con.execute("SELECT 1").fetchone()
        assert result[0] == 1

        con.close()

    def test_init_db_creates_primary_key_constraints(self, temp_dir):
        """Test that init_db creates tables with primary key constraints."""
        from scripts.generator.db import init_db

        # Mock load_env_config to avoid encryption issues with temp db
        with patch("scripts.generator.db.load_env_config", return_value={}):
            db_path = temp_dir / "test_pk.duckdb"
            con = init_db(str(db_path))

            # Check 'activities' table PK
            activities_info = con.execute("PRAGMA table_info('activities')").fetchdf()
            run_id_row = activities_info[activities_info["name"] == "run_id"]
            assert not run_id_row.empty
            # Use bool() to handle numpy bool types
            assert bool(run_id_row.iloc[0]["pk"]) is True

            # Check 'activities_flyby' table PK
            flyby_info = con.execute("PRAGMA table_info('activities_flyby')").fetchdf()
            activity_id_row = flyby_info[flyby_info["name"] == "activity_id"]
            time_offset_row = flyby_info[flyby_info["name"] == "time_offset"]

            assert not activity_id_row.empty
            assert bool(activity_id_row.iloc[0]["pk"]) is True
            assert not time_offset_row.empty
            assert bool(time_offset_row.iloc[0]["pk"]) is True

            con.close()

    def test_init_db_migrates_missing_pk(self, temp_dir):
        """Test that init_db adds missing primary keys to existing tables."""
        import duckdb

        from scripts.generator.db import init_db

        db_path = temp_dir / "test_migration.duckdb"
        con = duckdb.connect(str(db_path))

        # Create table WITHOUT PK manually
        con.execute("CREATE TABLE activities (run_id BIGINT, name VARCHAR)")
        con.execute("INSERT INTO activities VALUES (1, 'Run 1')")
        con.close()

        # Mock load_env_config to avoid encryption issues with temp db
        with patch("scripts.generator.db.load_env_config", return_value={}):
            # Run init_db which should migrate schema
            con = init_db(str(db_path))

            # Check PK
            activities_info = con.execute("PRAGMA table_info('activities')").fetchdf()
            run_id_row = activities_info[activities_info["name"] == "run_id"]
            assert bool(run_id_row.iloc[0]["pk"]) is True

            # Verify data preserved
            count = con.execute("SELECT count(*) FROM activities").fetchone()[0]
            assert count == 1
            name = con.execute("SELECT name FROM activities WHERE run_id=1").fetchone()[0]
            assert name == "Run 1"

            con.close()


class TestUpdateOrCreateActivities:
    """Test cases for update_or_create_activities function."""

    def test_insert_new_activities(self, temp_dir):
        """Test inserting new activities."""
        from scripts.generator.db import init_db, update_or_create_activities

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
        from scripts.generator.db import init_db, update_or_create_activities

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
        from scripts.generator.db import init_db, update_or_create_activities

        db_path = temp_dir / "test.duckdb"
        con = init_db(str(db_path))

        empty_df = pd.DataFrame()
        count = update_or_create_activities(con, empty_df)

        assert count == 0

        con.close()


class TestPruneActivities:
    """Test cases for pruning local activities not present on Strava."""

    def test_prune_activities_not_in_remote_ids_cascades_flyby(self, temp_dir):
        """Pruning removes stale activities and related flyby/queue records."""
        from scripts.generator.db import init_db, prune_activities_not_in_remote_ids

        db_path = temp_dir / "test_prune.duckdb"
        con = init_db(str(db_path))

        con.execute("INSERT INTO activities (run_id, name) VALUES (1, 'A'), (2, 'B'), (3, 'C')")
        con.execute(
            """
            INSERT INTO activities_flyby (activity_id, time_offset, pace)
            VALUES (1, 0, 5.0), (2, 0, 6.0), (2, 10, 6.2), (3, 0, 4.5)
            """
        )
        con.execute(
            """
            INSERT INTO activities_flyby_queue (activity_id, status, updated_at)
            VALUES (2, 'pending', NOW()), (3, 'pending', NOW())
            """
        )

        deleted = prune_activities_not_in_remote_ids(con, {1, 3})
        assert deleted == 1

        remaining_ids = {row[0] for row in con.execute("SELECT run_id FROM activities").fetchall()}
        assert remaining_ids == {1, 3}

        flyby_ids = {row[0] for row in con.execute("SELECT DISTINCT activity_id FROM activities_flyby").fetchall()}
        assert flyby_ids == {1, 3}

        queue_ids = {row[0] for row in con.execute("SELECT activity_id FROM activities_flyby_queue").fetchall()}
        assert queue_ids == {3}

        con.close()

    def test_prune_activities_not_in_remote_ids_with_empty_remote_set(self, temp_dir):
        """When remote set is empty, all local activities are pruned."""
        from scripts.generator.db import init_db, prune_activities_not_in_remote_ids

        db_path = temp_dir / "test_prune_empty.duckdb"
        con = init_db(str(db_path))
        con.execute("INSERT INTO activities (run_id, name) VALUES (1, 'A'), (2, 'B')")
        con.execute("INSERT INTO activities_flyby (activity_id, time_offset, pace) VALUES (1, 0, 5.0), (2, 0, 5.0)")

        deleted = prune_activities_not_in_remote_ids(con, set())
        assert deleted == 2
        assert con.execute("SELECT COUNT(*) FROM activities").fetchone()[0] == 0
        assert con.execute("SELECT COUNT(*) FROM activities_flyby").fetchone()[0] == 0

        con.close()


class TestMigrateSchema:
    """Test cases for _migrate_schema function."""

    def test_migrate_schema_adds_missing_columns(self, temp_dir):
        """Test that migration adds missing columns."""
        from scripts.generator.db import _migrate_schema

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
        from scripts.generator.db import init_db

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
        from scripts.generator.db import _geocode_cache

        assert isinstance(_geocode_cache, dict)

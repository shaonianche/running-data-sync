"""Tests for scripts.synced_data_file_logger.py module."""

import json
from unittest.mock import patch


class TestSyncedDataFileLogger:
    """Test cases for synced data file logger functions."""

    def test_load_synced_file_list_missing_file(self, temp_dir):
        """Test loading when the synced file doesn't exist."""
        with patch("scripts.synced_data_file_logger.SYNCED_FILE", str(temp_dir / "nonexistent.json")):
            from scripts.synced_data_file_logger import load_synced_file_list

            result = load_synced_file_list()
            assert result == []

    def test_load_synced_file_list_valid_file(self, temp_dir):
        """Test loading a valid synced file."""
        synced_file = temp_dir / "synced.json"
        test_data = ["file1.gpx", "file2.gpx", "file3.gpx"]
        synced_file.write_text(json.dumps(test_data))

        with patch("scripts.synced_data_file_logger.SYNCED_FILE", str(synced_file)):
            from scripts.synced_data_file_logger import load_synced_file_list

            result = load_synced_file_list()
            assert result == test_data

    def test_load_synced_file_list_invalid_json(self, temp_dir):
        """Test loading a file with invalid JSON."""
        synced_file = temp_dir / "synced.json"
        synced_file.write_text("not valid json {{{")

        with patch("scripts.synced_data_file_logger.SYNCED_FILE", str(synced_file)):
            from scripts.synced_data_file_logger import load_synced_file_list

            result = load_synced_file_list()
            assert result == []

    def test_load_synced_file_list_empty_file(self, temp_dir):
        """Test loading an empty file."""
        synced_file = temp_dir / "synced.json"
        synced_file.write_text("")

        with patch("scripts.synced_data_file_logger.SYNCED_FILE", str(synced_file)):
            from scripts.synced_data_file_logger import load_synced_file_list

            result = load_synced_file_list()
            assert result == []

    def test_save_synced_data_file_list_new_file(self, temp_dir):
        """Test saving to a new synced file."""
        synced_file = temp_dir / "synced.json"

        with patch("scripts.synced_data_file_logger.SYNCED_FILE", str(synced_file)):
            from scripts.synced_data_file_logger import save_synced_data_file_list

            new_files = ["file1.gpx", "file2.gpx"]
            save_synced_data_file_list(new_files)

            # Read the file and verify
            with open(synced_file) as f:
                saved_data = json.load(f)

            assert "file1.gpx" in saved_data
            assert "file2.gpx" in saved_data

    def test_save_synced_data_file_list_appends_to_existing(self, temp_dir):
        """Test that saving appends to existing file list."""
        synced_file = temp_dir / "synced.json"
        existing_data = ["existing1.gpx", "existing2.gpx"]
        synced_file.write_text(json.dumps(existing_data))

        with patch("scripts.synced_data_file_logger.SYNCED_FILE", str(synced_file)):
            from scripts.synced_data_file_logger import (
                save_synced_data_file_list,
            )

            new_files = ["new1.gpx", "new2.gpx"]
            save_synced_data_file_list(new_files)

            # Read the file and verify
            with open(synced_file) as f:
                saved_data = json.load(f)

            # Should contain both old and new files
            assert "new1.gpx" in saved_data
            assert "new2.gpx" in saved_data
            assert "existing1.gpx" in saved_data
            assert "existing2.gpx" in saved_data

    def test_save_synced_data_file_list_empty_list(self, temp_dir):
        """Test saving an empty list."""
        synced_file = temp_dir / "synced.json"
        existing_data = ["existing.gpx"]
        synced_file.write_text(json.dumps(existing_data))

        with patch("scripts.synced_data_file_logger.SYNCED_FILE", str(synced_file)):
            from scripts.synced_data_file_logger import save_synced_data_file_list

            save_synced_data_file_list([])

            # Read the file and verify
            with open(synced_file) as f:
                saved_data = json.load(f)

            # Should still contain existing files
            assert "existing.gpx" in saved_data

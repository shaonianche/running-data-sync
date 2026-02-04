import unittest
from unittest.mock import MagicMock, patch, mock_open
import pandas as pd
import datetime
from scripts.export_fit import construct_dataframes, validate_activity, calculate_laps_from_records
from fit_tool.profile.profile_type import Sport, SubSport


class TestExportFit(unittest.TestCase):
    def setUp(self):
        # Sample Activity Data
        self.activity_row = pd.Series(
            {
                "run_id": 12345,
                "name": "Test Run",
                "start_date": "2023-01-01 10:00:00",
                "elapsed_time": 3600,
                "moving_time": 3500,
                "distance": 10000,
                "type": "Run",
                "average_speed": 2.8,
                "average_heartrate": 150,
            }
        )

        # Sample Flyby Data (Small set)
        self.flyby_df = pd.DataFrame(
            {
                "time_offset": [0, 60, 120],
                "lat": [40.0, 40.001, 40.002],
                "lng": [-74.0, -74.001, -74.002],
                "distance": [0, 160, 320],
                "alt": [10, 12, 15],
                "pace": [5.0, 5.0, 5.0],
                "hr": [140, 150, 160],
                "cadence": [170, 180, 190],
                "watts": [200, 210, 220],
            }
        )

    def test_construct_dataframes_basic(self):
        """Test if dataframes are constructed with correct columns and types"""
        dfs = construct_dataframes(self.activity_row, self.flyby_df)

        # Check keys
        self.assertIn("fit_file_id", dfs)
        self.assertIn("fit_record", dfs)
        self.assertIn("fit_session", dfs)
        self.assertIn("fit_lap", dfs)

        # Check Session Sport/SubSport
        session = dfs["fit_session"]
        self.assertEqual(session.iloc[0]["sport"], Sport.RUNNING.value)
        self.assertEqual(session.iloc[0]["sub_sport"], SubSport.STREET.value)  # Should default to STREET for Run

    def test_construct_dataframes_subsport_mapping(self):
        """Test if different activity types map to correct SubSports"""

        # Trail Run
        trail_row = self.activity_row.copy()
        trail_row["type"] = "TrailRun"
        dfs = construct_dataframes(trail_row, self.flyby_df)
        self.assertEqual(dfs["fit_session"].iloc[0]["sub_sport"], SubSport.TRAIL.value)

        # Treadmill
        treadmill_row = self.activity_row.copy()
        treadmill_row["type"] = "Treadmill"
        dfs = construct_dataframes(treadmill_row, self.flyby_df)
        self.assertEqual(dfs["fit_session"].iloc[0]["sub_sport"], SubSport.TREADMILL.value)

    def test_laps_calculation(self):
        """Test lap generation logic"""
        # Create enough data for > 1km
        # 1km = 1000m.
        # Let's make points: 0m, 500m, 1100m
        flyby_data = {
            "timestamp": [
                datetime.datetime(2023, 1, 1, 10, 0, 0),
                datetime.datetime(2023, 1, 1, 10, 5, 0),
                datetime.datetime(2023, 1, 1, 10, 10, 0),
            ],
            "distance": [0, 500, 1100],
            "speed": [3.0, 3.0, 3.0],
            "heart_rate": [150, 150, 150],
            "cadence": [180, 180, 180],
            "power": [200, 200, 200],
        }
        fit_record = pd.DataFrame(flyby_data)

        laps = calculate_laps_from_records(fit_record, 12345, datetime.datetime(2023, 1, 1, 10, 0, 0))

        self.assertIsNotNone(laps)
        self.assertFalse(laps.empty)
        # Should have at least 1 lap (0-1100m covers 1 full lap + remainder)
        # 0 -> 1100 is > 1000. So index 2 triggers a lap.
        # But wait, logic is: curr - start >= 1000.
        # 500 - 0 = 500.
        # 1100 - 0 = 1100 >= 1000. Lap triggers at index 2.
        # Remaining: 0. (End of data).
        # So we expect 1 lap of 1100m? Or 1 lap of 1000m?
        # The logic simply cuts when threshold passed.
        # It slices [start_idx : i+1].
        # So it creates one lap covering 0 to 1100m.
        # And resets start_idx to i (2).
        # Loop ends.
        # Final lap check: start_idx (2) < len(3)-1? No. 2 < 2 is False.
        # So 1 lap total.

        self.assertEqual(len(laps), 1)
        self.assertEqual(laps.iloc[0]["total_distance"], 1100.0)

    @patch("scripts.export_fit.duckdb.connect")
    def test_validate_activity_found(self, mock_connect):
        """Test validate_activity when ID exists"""
        mock_con = MagicMock()
        mock_connect.return_value = mock_con

        # Mock fetchdf return
        mock_df = pd.DataFrame([self.activity_row])
        mock_con.execute.return_value.fetchdf.return_value = mock_df

        result = validate_activity(mock_con, 12345)
        self.assertIsNotNone(result)
        self.assertEqual(result["run_id"], 12345)

    @patch("scripts.export_fit.duckdb.connect")
    def test_validate_activity_not_found(self, mock_connect):
        """Test validate_activity when ID does not exist"""
        mock_con = MagicMock()
        mock_connect.return_value = mock_con

        # Empty DataFrame
        mock_con.execute.return_value.fetchdf.return_value = pd.DataFrame()

        result = validate_activity(mock_con, 99999)
        self.assertIsNone(result)


if __name__ == "__main__":
    unittest.main()

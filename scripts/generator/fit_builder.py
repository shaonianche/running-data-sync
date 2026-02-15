"""FIT file building utilities."""

import pandas as pd
from fit_tool.fit_file_builder import FitFileBuilder
from fit_tool.profile.messages.activity_message import ActivityMessage
from fit_tool.profile.messages.device_info_message import DeviceInfoMessage
from fit_tool.profile.messages.event_message import EventMessage
from fit_tool.profile.messages.file_creator_message import FileCreatorMessage
from fit_tool.profile.messages.file_id_message import FileIdMessage
from fit_tool.profile.messages.lap_message import LapMessage
from fit_tool.profile.messages.record_message import RecordMessage
from fit_tool.profile.messages.session_message import SessionMessage
from fit_tool.profile.messages.sport_message import SportMessage
from fit_tool.profile.profile_type import (
    Activity,
    Event,
    EventType,
    FileType,
    SessionTrigger,
    SourceType,
    SubSport,
)


class FitBuilderMixin:
    """Mixin class providing FIT file building methods for Generator."""

    @staticmethod
    def _fit_distance_raw(distance_m):
        if pd.isna(distance_m):
            return None
        return int(round(float(distance_m) * 100))

    @staticmethod
    def _fit_speed_raw(speed_mps):
        if pd.isna(speed_mps):
            return None
        return int(round(float(speed_mps) * 1000))

    @staticmethod
    def _fit_duration_raw(duration_s):
        if pd.isna(duration_s):
            return None
        return int(round(float(duration_s) * 1000))

    @staticmethod
    def _fit_altitude_raw(altitude_m):
        if pd.isna(altitude_m):
            return None
        # fit_tool's RecordAltitudeField applies an extra +500 offset during encoding.
        # Input value must satisfy: ((value + 500) / 5 - 500) == altitude_m.
        return int(round(float(altitude_m) * 5.0 + 2000.0))

    def build_fit_file_from_dataframes(self, dataframes):
        """
        Builds a FIT file from a dictionary of DataFrames,
        following the official example's logic.
        """
        builder = FitFileBuilder(auto_define=True)

        # The order of messages is important.
        fit_lap_df = dataframes.get("fit_lap")
        self._last_fit_lap_count = len(fit_lap_df) if fit_lap_df is not None else 0

        self._add_file_id_mesg(builder, dataframes.get("fit_file_id"))
        self._add_file_creator_mesg(builder)
        self._add_device_info_mesg(builder, dataframes.get("fit_file_id"))
        self._add_sport_mesg(builder, dataframes.get("fit_session"))
        self._add_event_mesg(builder, dataframes, event_type="start")
        self._add_record_mesgs(builder, dataframes.get("fit_record"))
        self._add_lap_mesg(builder, fit_lap_df)
        self._add_event_mesg(builder, dataframes, event_type="stop")
        self._add_session_mesg(builder, dataframes.get("fit_session"))
        self._add_activity_mesg(builder, dataframes.get("fit_session"))

        return builder.build().to_bytes()

    def _add_file_id_mesg(self, builder, df):
        if df is None or df.empty:
            return
        msg = FileIdMessage()
        row = df.iloc[0]
        msg.type = FileType(row["type"])
        msg.manufacturer = 1  # Force Garmin for compatibility
        msg.product = row["product"]
        msg.serial_number = self.serial_number
        msg.time_created = round(row["time_created"].timestamp() * 1000)
        builder.add(msg)

    def _add_file_creator_mesg(self, builder):
        msg = FileCreatorMessage()
        msg.software_version = 0
        msg.hardware_version = 0
        builder.add(msg)

    def _add_device_info_mesg(self, builder, df):
        if df is None or df.empty:
            return
        row = df.iloc[0]

        msg = DeviceInfoMessage()
        msg.serial_number = self.serial_number
        msg.manufacturer = row["manufacturer"]
        msg.garmin_product = row["product"]
        msg.software_version = row["software_version"]
        msg.device_index = 0
        msg.source_type = SourceType.LOCAL
        msg.product = row["product"]
        msg.timestamp = round(row["time_created"].timestamp() * 1000)

        builder.add(msg)

    def _add_event_mesg(self, builder, dataframes, event_type):
        if event_type == "start":
            timestamp = dataframes["fit_session"].iloc[0]["start_time"]
            event_type_enum = EventType.START
            event_enum = Event.TIMER
        else:  # stop
            timestamp = dataframes["fit_session"].iloc[0]["timestamp"]
            event_type_enum = EventType.STOP_ALL
            event_enum = Event.TIMER  # Use TIMER for stop event

        timestamp_ms = round(timestamp.timestamp() * 1000)

        event_msg = EventMessage()
        event_msg.event = event_enum
        event_msg.event_type = event_type_enum
        event_msg.timestamp = timestamp_ms
        event_msg.data = 0  # Match reference file
        builder.add(event_msg)

    def _add_record_mesgs(self, builder, df):
        if df is None or df.empty:
            return
        for row in df.itertuples(index=False):
            msg = RecordMessage()
            msg.timestamp = round(row.timestamp.timestamp() * 1000)

            if pd.notna(row.position_lat):
                msg.position_lat = row.position_lat
            if pd.notna(row.position_long):
                msg.position_long = row.position_long
            if pd.notna(row.distance):
                msg.distance = self._fit_distance_raw(row.distance)
            if pd.notna(row.altitude):
                msg.altitude = self._fit_altitude_raw(row.altitude)
            if pd.notna(row.speed):
                msg.speed = self._fit_speed_raw(row.speed)
            if pd.notna(row.heart_rate):
                msg.heart_rate = int(row.heart_rate)
            if pd.notna(row.cadence):
                msg.cadence = int(row.cadence)
            if pd.notna(row.power):
                msg.power = int(row.power)
            if pd.notna(row.step_length):
                msg.step_length = float(row.step_length * 1000)

            builder.add(msg)

    def _add_activity_mesg(self, builder, df):
        if df is None or df.empty:
            return
        row = df.iloc[0]
        msg = ActivityMessage()
        msg.timestamp = round(row["timestamp"].timestamp() * 1000)
        msg.total_timer_time = self._fit_duration_raw(row["total_timer_time"])
        msg.num_sessions = 1
        msg.type = Activity.MANUAL
        msg.event = Event.ACTIVITY
        msg.event_type = EventType.STOP
        builder.add(msg)

    def _add_lap_mesg(self, builder, df):
        if df is None or df.empty:
            # Skip adding Lap message if dataframe is empty
            return
        for index, row in enumerate(df.itertuples(index=False)):
            msg = LapMessage()
            msg.message_index = index
            msg.timestamp = round(row.timestamp.timestamp() * 1000)
            msg.start_time = round(row.start_time.timestamp() * 1000)
            msg.total_elapsed_time = self._fit_duration_raw(row.total_elapsed_time)
            msg.total_timer_time = self._fit_duration_raw(row.total_timer_time)
            msg.total_distance = self._fit_distance_raw(row.total_distance)
            if pd.notna(row.avg_speed):
                msg.avg_speed = self._fit_speed_raw(row.avg_speed)
            if pd.notna(row.avg_heart_rate):
                msg.avg_heart_rate = row.avg_heart_rate
            if pd.notna(row.avg_cadence):
                msg.avg_cadence = row.avg_cadence
            if hasattr(row, "avg_power") and pd.notna(row.avg_power):
                msg.avg_power = row.avg_power
            builder.add(msg)

    def _add_sport_mesg(self, builder, df):
        if df is None or df.empty:
            return
        row = df.iloc[0]
        msg = SportMessage()
        msg.sport = row["sport"]

        # SubSport Mapping based on Activity Type
        if "sub_sport" in row and pd.notna(row["sub_sport"]):
            msg.sub_sport = row["sub_sport"]
        else:
            msg.sub_sport = SubSport.GENERIC

        # Add activity title so Garmin can reuse it instead of a generic localized label.
        if "name" in row and pd.notna(row["name"]):
            msg.sport_name = str(row["name"])

        builder.add(msg)

    def _add_session_mesg(self, builder, df):
        if df is None or df.empty:
            return
        msg = SessionMessage()
        row = df.iloc[0]

        msg.timestamp = round(row["timestamp"].timestamp() * 1000)

        msg.start_time = round(row["start_time"].timestamp() * 1000)

        msg.total_elapsed_time = self._fit_duration_raw(row["total_elapsed_time"])
        msg.total_timer_time = self._fit_duration_raw(row["total_timer_time"])
        msg.total_distance = self._fit_distance_raw(row["total_distance"])
        msg.sport = row["sport"]

        if "sub_sport" in row and pd.notna(row["sub_sport"]):
            msg.sub_sport = row["sub_sport"]
        else:
            msg.sub_sport = SubSport.GENERIC

        lap_count = 1
        if hasattr(self, "_last_fit_lap_count"):
            lap_count = max(1, int(self._last_fit_lap_count))
        msg.num_laps = lap_count
        msg.first_lap_index = 0
        msg.event = Event.SESSION
        msg.event_type = EventType.STOP
        msg.trigger = SessionTrigger.ACTIVITY_END

        # Add Sport Event if available
        if "sport_event" in row and pd.notna(row["sport_event"]):
            msg.sport_event = row["sport_event"]

        if pd.notna(row["avg_speed"]):
            msg.avg_speed = self._fit_speed_raw(row["avg_speed"])
        if pd.notna(row["avg_heart_rate"]):
            msg.avg_heart_rate = row["avg_heart_rate"]
        if pd.notna(row["avg_cadence"]):
            msg.avg_cadence = row["avg_cadence"]
        if "avg_power" in row and pd.notna(row["avg_power"]):
            msg.avg_power = row["avg_power"]
        if "name" in row and pd.notna(row["name"]):
            msg.sport_profile_name = str(row["name"])
        builder.add(msg)

from __future__ import annotations

from datetime import timedelta
from pathlib import Path
from xml.dom import minidom
from xml.etree.ElementTree import Element, SubElement, tostring

import gpxpy.gpx
import pandas as pd

from ..export_fit import construct_dataframes
from ..generator import Generator
from ..generator.db import get_db_connection
from ..utils import get_logger
from .types import RuntimeConfig

logger = get_logger(__name__)

SUPPORTED_EXPORT_FORMATS = {"fit", "tcx", "gpx"}


def _iter_target_activity_ids(
    con,
    *,
    export_all: bool,
    include_ids: list[int],
    id_range: tuple[int, int] | None,
) -> list[int]:
    if export_all:
        rows = con.execute("SELECT run_id FROM activities ORDER BY run_id").fetchall()
        return [int(row[0]) for row in rows]

    ids = set(include_ids)
    if id_range:
        start, end = id_range
        rows = con.execute(
            "SELECT run_id FROM activities WHERE run_id BETWEEN ? AND ? ORDER BY run_id",
            [start, end],
        ).fetchall()
        ids.update(int(row[0]) for row in rows)
    return sorted(ids)


def _write_gpx(activity_row: pd.Series, flyby_df: pd.DataFrame, output_file: Path) -> None:
    if flyby_df.empty:
        raise ValueError("No flyby data available for GPX export.")
    gpx = gpxpy.gpx.GPX()
    track = gpxpy.gpx.GPXTrack()
    track.name = str(activity_row.get("name") or activity_row.get("run_id"))
    gpx.tracks.append(track)
    segment = gpxpy.gpx.GPXTrackSegment()
    track.segments.append(segment)

    start_date = pd.to_datetime(activity_row["start_date"])
    for row in flyby_df.itertuples(index=False):
        if pd.isna(row.lat) or pd.isna(row.lng):
            continue
        point_time = start_date + timedelta(seconds=int(row.time_offset))
        segment.points.append(
            gpxpy.gpx.GPXTrackPoint(
                latitude=float(row.lat),
                longitude=float(row.lng),
                elevation=float(row.alt) if row.alt is not None and not pd.isna(row.alt) else None,
                time=point_time,
            )
        )

    output_file.write_text(gpx.to_xml(), encoding="utf-8")


def _write_tcx(activity_row: pd.Series, flyby_df: pd.DataFrame, output_file: Path) -> None:
    if flyby_df.empty:
        raise ValueError("No flyby data available for TCX export.")

    start_date = pd.to_datetime(activity_row["start_date"])
    root = Element("TrainingCenterDatabase")
    root.attrib = {
        "xmlns": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2",
        "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance",
        "xsi:schemaLocation": "http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2 "
        "http://www.garmin.com/xmlschemas/TrainingCenterDatabasev2.xsd",
    }
    activities_node = SubElement(root, "Activities")
    activity_node = SubElement(activities_node, "Activity")
    activity_node.set("Sport", str(activity_row.get("type") or "Other"))
    activity_id_node = SubElement(activity_node, "Id")
    activity_id_node.text = start_date.isoformat()

    lap_node = SubElement(activity_node, "Lap")
    lap_node.set("StartTime", start_date.isoformat())
    SubElement(lap_node, "TotalTimeSeconds").text = str(float(activity_row.get("elapsed_time") or 0))
    SubElement(lap_node, "DistanceMeters").text = str(float(activity_row.get("distance") or 0))
    SubElement(lap_node, "Intensity").text = "Active"
    SubElement(lap_node, "TriggerMethod").text = "Manual"
    track_node = SubElement(lap_node, "Track")

    for row in flyby_df.itertuples(index=False):
        if pd.isna(row.lat) or pd.isna(row.lng):
            continue
        trackpoint_node = SubElement(track_node, "Trackpoint")
        point_time = start_date + timedelta(seconds=int(row.time_offset))
        SubElement(trackpoint_node, "Time").text = point_time.isoformat()
        position_node = SubElement(trackpoint_node, "Position")
        SubElement(position_node, "LatitudeDegrees").text = str(float(row.lat))
        SubElement(position_node, "LongitudeDegrees").text = str(float(row.lng))
        if row.alt is not None and not pd.isna(row.alt):
            SubElement(trackpoint_node, "AltitudeMeters").text = str(float(row.alt))
        if row.hr is not None and not pd.isna(row.hr):
            hr_node = SubElement(trackpoint_node, "HeartRateBpm")
            SubElement(hr_node, "Value").text = str(int(row.hr))

    creator_node = SubElement(activity_node, "Creator")
    creator_node.set("xsi:type", "Device_t")
    SubElement(creator_node, "Name").text = "Strava"

    xml_str = tostring(root, "utf-8")
    output_file.write_text(minidom.parseString(xml_str).toprettyxml(indent="  "), encoding="utf-8")


def _load_activity_and_flyby(con, activity_id: int) -> tuple[pd.Series, pd.DataFrame]:
    activity_df = con.execute("SELECT * FROM activities WHERE run_id = ?", [activity_id]).fetchdf()
    if activity_df.empty:
        raise ValueError(f"Activity {activity_id} not found in DuckDB.")
    flyby_df = con.execute(
        "SELECT * FROM activities_flyby WHERE activity_id = ? ORDER BY time_offset",
        [activity_id],
    ).fetchdf()
    return activity_df.iloc[0], flyby_df


def run_export(
    *,
    runtime_config: RuntimeConfig,
    export_format: str,
    export_all: bool,
    include_ids: list[int],
    id_range: tuple[int, int] | None,
    output_dir: Path | None,
) -> list[Path]:
    fmt = export_format.lower()
    if fmt not in SUPPORTED_EXPORT_FORMATS:
        raise ValueError(f"Unsupported format: {export_format}. Supported: {sorted(SUPPORTED_EXPORT_FORMATS)}")

    if not export_all and not include_ids and not id_range:
        raise ValueError("Export target is empty. Use --all, --id, or --id-range.")

    generator = Generator(runtime_config.sql_file)
    con = get_db_connection(runtime_config.sql_file, read_only=True)
    try:
        activity_ids = _iter_target_activity_ids(
            con,
            export_all=export_all,
            include_ids=include_ids,
            id_range=id_range,
        )
    finally:
        con.close()

    if not activity_ids:
        logger.info("No activities matched export filters.")
        return []

    if output_dir is None:
        output_dir = {
            "fit": runtime_config.fit_dir,
            "tcx": runtime_config.tcx_dir,
            "gpx": runtime_config.gpx_dir,
        }[fmt]
    output_dir.mkdir(parents=True, exist_ok=True)

    written_files: list[Path] = []
    con = get_db_connection(runtime_config.sql_file, read_only=True)
    for activity_id in activity_ids:
        try:
            activity_row, flyby_df = _load_activity_and_flyby(con, activity_id)
            output_file = output_dir / f"{activity_id}.{fmt}"
            if fmt == "fit":
                dataframes = construct_dataframes(activity_row, flyby_df)
                output_file.write_bytes(generator.build_fit_file_from_dataframes(dataframes))
            elif fmt == "tcx":
                _write_tcx(activity_row, flyby_df, output_file)
            else:
                _write_gpx(activity_row, flyby_df, output_file)
            written_files.append(output_file)
        except Exception as exc:
            logger.error("Failed to export activity %s to %s: %s", activity_id, fmt, exc, exc_info=True)
    con.close()

    logger.info("Exported %d/%d activities to %s.", len(written_files), len(activity_ids), output_dir)
    return written_files

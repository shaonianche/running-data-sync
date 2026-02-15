from __future__ import annotations

import asyncio
import hashlib
import json
from collections import namedtuple
from datetime import datetime, timezone

import pandas as pd

from ..export_fit import construct_dataframes
from ..garmin_sync import Garmin
from ..generator import Generator
from ..utils import get_logger
from .store import SYNCED_STATUSES, ensure_vendor_sync_table, load_vendor_sync_rows, upsert_vendor_sync_status
from .types import GarminCredentials, RuntimeConfig

logger = get_logger(__name__)
FIT_UPLOAD_RECORD = namedtuple("FitUploadRecord", ["filename", "content"])

VENDOR_NAME = "garmin"


def _account_name(is_cn: bool) -> str:
    return "garmin_cn" if is_cn else "garmin_com"


def _auth_domain(is_cn: bool) -> str:
    return "CN" if is_cn else ""


def _parse_garmin_start_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _parse_garmin_duration_seconds(garmin_activity: dict) -> float | None:
    for key in (
        "duration",
        "elapsedDuration",
        "movingDuration",
        "durationInSeconds",
        "elapsedDurationInSeconds",
        "movingDurationInSeconds",
    ):
        value = garmin_activity.get(key)
        if value is not None:
            try:
                return float(value)
            except (TypeError, ValueError):
                continue
    return None


def _extract_garmin_type_key(garmin_activity: dict) -> str | None:
    for key in ("activityType", "activityTypeDTO"):
        raw = garmin_activity.get(key)
        if isinstance(raw, dict):
            type_key = raw.get("typeKey")
            if type_key:
                return str(type_key).lower()
    return None


def _strava_type_aliases(strava_type: str | None) -> set[str]:
    if not strava_type:
        return set()
    aliases = {
        "Run": {"running", "street_running", "trail_running", "treadmill_running"},
        "TrailRun": {"running", "trail_running"},
        "Treadmill": {"running", "treadmill_running"},
        "VirtualRun": {"running", "virtual_running"},
        "Walk": {"walking"},
        "Hike": {"hiking", "walking"},
        "Ride": {"cycling", "road_biking"},
        "VirtualRide": {"cycling", "indoor_cycling", "virtual_ride"},
        "GravelRide": {"cycling", "gravel_cycling"},
        "MountainBikeRide": {"cycling", "mountain_biking"},
        "EBikeRide": {"cycling", "e_biking"},
        "Workout": {"fitness", "strength_training", "cardio_training", "indoor_cardio", "boxing"},
        "WeightTraining": {"strength_training", "fitness"},
        "Boxing": {"boxing", "fitness"},
        "Crossfit": {"cross_training", "strength_training", "fitness"},
        "Yoga": {"yoga"},
        "Elliptical": {"elliptical"},
        "StairStepper": {"stair_stepper"},
    }
    return aliases.get(strava_type, {strava_type.lower()})


def _prefer_duration_match(activity_row: pd.Series) -> bool:
    distance = float(activity_row.get("distance") or 0)
    strava_type = str(activity_row.get("type") or "")
    if distance <= 1:
        return True
    return strava_type in {
        "Workout",
        "WeightTraining",
        "Boxing",
        "Crossfit",
        "Yoga",
        "Elliptical",
        "StairStepper",
    }


def _is_existing_in_garmin(
    activity_row: pd.Series,
    garmin_activities: list[dict],
    *,
    match_window_seconds: int,
    distance_tolerance_meters: float,
    duration_tolerance_seconds: int,
    reserved_activity_ids: set[int] | None = None,
) -> int | None:
    strava_start = pd.to_datetime(activity_row["start_date"]).to_pydatetime()
    if strava_start.tzinfo is None:
        strava_start = strava_start.replace(tzinfo=timezone.utc)
    strava_distance = float(activity_row.get("distance") or 0)
    strava_elapsed = float(activity_row.get("elapsed_time") or 0)
    prefer_duration = _prefer_duration_match(activity_row)
    allowed_types = _strava_type_aliases(activity_row.get("type"))

    candidates: list[tuple[float, float, int]] = []
    for garmin_activity in garmin_activities:
        garmin_start = _parse_garmin_start_time(garmin_activity.get("startTimeGMT"))
        if garmin_start is None:
            continue
        garmin_activity_id = garmin_activity.get("activityId")
        if not garmin_activity_id:
            continue
        garmin_activity_id = int(garmin_activity_id)
        if reserved_activity_ids and garmin_activity_id in reserved_activity_ids:
            continue

        time_delta = abs((strava_start - garmin_start).total_seconds())
        if time_delta > match_window_seconds:
            continue

        garmin_type = _extract_garmin_type_key(garmin_activity)

        if prefer_duration:
            if allowed_types and garmin_type and garmin_type not in allowed_types:
                continue
            garmin_duration = _parse_garmin_duration_seconds(garmin_activity)
            if garmin_duration is None:
                continue
            secondary_delta = abs(strava_elapsed - garmin_duration)
            if secondary_delta > duration_tolerance_seconds:
                continue
        else:
            if allowed_types and garmin_type and garmin_type not in allowed_types:
                continue
            garmin_distance = float(garmin_activity.get("distance") or 0)
            secondary_delta = abs(strava_distance - garmin_distance)
            if secondary_delta > distance_tolerance_meters:
                continue

        candidates.append((time_delta, secondary_delta, garmin_activity_id))

    if not candidates:
        return None
    candidates.sort(key=lambda item: (item[0], item[1], item[2]))
    return candidates[0][2]


def _activity_content_hash(activity_row: pd.Series, flyby_df: pd.DataFrame) -> str:
    # Keep the hash stable across runs to detect local changes and trigger re-validation/re-upload.
    activity_payload = {
        "run_id": int(activity_row["run_id"]),
        "start_date": str(activity_row.get("start_date") or ""),
        "distance": float(activity_row.get("distance") or 0),
        "moving_time": float(activity_row.get("moving_time") or 0),
        "elapsed_time": float(activity_row.get("elapsed_time") or 0),
        "total_elevation_gain": float(activity_row.get("total_elevation_gain") or 0),
        "average_speed": float(activity_row.get("average_speed") or 0),
        "average_heartrate": float(activity_row.get("average_heartrate") or 0),
    }
    desired_columns = ["time_offset", "lat", "lng", "alt", "hr", "cadence", "speed", "distance"]
    available_columns = [column for column in desired_columns if column in flyby_df.columns]
    if not available_columns:
        flyby_payload = []
    else:
        subset = flyby_df[available_columns].copy().astype(object)
        subset = subset.where(pd.notna(subset), None)
        flyby_payload = subset.to_dict(orient="records")
    raw = json.dumps({"activity": activity_payload, "flyby": flyby_payload}, ensure_ascii=True, sort_keys=True)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _extract_remote_activity_id_from_upload_result(upload_result) -> int | None:
    if isinstance(upload_result, dict):
        for key in ("activityId", "activity_id", "garminActivityId", "activityPk", "activityPK"):
            value = upload_result.get(key)
            if value is None:
                continue
            try:
                return int(value)
            except (TypeError, ValueError):
                continue
        for value in upload_result.values():
            nested = _extract_remote_activity_id_from_upload_result(value)
            if nested is not None:
                return nested
    elif isinstance(upload_result, list):
        for item in upload_result:
            nested = _extract_remote_activity_id_from_upload_result(item)
            if nested is not None:
                return nested
    return None


async def _fetch_garmin_activities(
    garmin_client: Garmin,
    *,
    page_size: int = 100,
    max_pages: int | None = None,
) -> list[dict]:
    activities: list[dict] = []
    page = 0
    while True:
        if max_pages is not None and page >= max_pages:
            break
        batch = await garmin_client.get_activities(page * page_size, page_size)
        if not batch:
            break
        activities.extend(batch)
        if len(batch) < page_size:
            break
        page += 1
    return activities


async def _delete_all_garmin_activities(
    garmin_client: Garmin,
    garmin_activities: list[dict],
) -> int:
    deleted = 0
    for activity in garmin_activities:
        activity_id = activity.get("activityId")
        if activity_id is None:
            continue
        await garmin_client.delete_activity(int(activity_id))
        deleted += 1
    return deleted


def _load_local_activities(db_con) -> pd.DataFrame:
    activities_df = db_con.execute(
        "SELECT * FROM activities ORDER BY run_id",
    ).fetchdf()
    return activities_df


def _reconcile_rows(
    *,
    db_con,
    activities_df: pd.DataFrame,
    garmin_activities: list[dict],
    account: str,
    match_window_seconds: int,
    distance_tolerance_meters: float,
    duration_tolerance_seconds: int,
) -> None:
    state_map = load_vendor_sync_rows(db_con, vendor=VENDOR_NAME, account=account)
    garmin_ids = {
        int(activity["activityId"])
        for activity in garmin_activities
        if activity.get("activityId") is not None
    }
    reserved_remote_ids: set[int] = set()

    for _, activity_row in activities_df.iterrows():
        activity_id = int(activity_row["run_id"])
        state = state_map.get(activity_id)

        matched_remote_id: int | None = None
        if (
            state
            and state.remote_activity_id
            and state.remote_activity_id in garmin_ids
            and state.remote_activity_id not in reserved_remote_ids
        ):
            matched_remote_id = state.remote_activity_id
        else:
            matched_remote_id = _is_existing_in_garmin(
                activity_row,
                garmin_activities,
                match_window_seconds=match_window_seconds,
                distance_tolerance_meters=distance_tolerance_meters,
                duration_tolerance_seconds=duration_tolerance_seconds,
                reserved_activity_ids=reserved_remote_ids,
            )

        if matched_remote_id is not None:
            reserved_remote_ids.add(matched_remote_id)
            upsert_vendor_sync_status(
                db_con,
                activity_id=activity_id,
                vendor=VENDOR_NAME,
                account=account,
                status="synced",
                remote_activity_id=matched_remote_id,
                last_error=None,
                last_verified_at=datetime.now(tz=timezone.utc),
            )
            continue

        if state and state.status in SYNCED_STATUSES:
            upsert_vendor_sync_status(
                db_con,
                activity_id=activity_id,
                vendor=VENDOR_NAME,
                account=account,
                status="missing_remote",
                remote_activity_id=state.remote_activity_id,
                content_hash=state.content_hash,
                last_error="Remote activity not found during reconcile.",
                attempt_count=state.attempt_count,
            )


async def run_reconcile_garmin(
    *,
    garmin_credentials: GarminCredentials,
    runtime_config: RuntimeConfig,
    match_window_seconds: int,
    distance_tolerance_meters: float,
    duration_tolerance_seconds: int,
) -> None:
    account = _account_name(garmin_credentials.is_cn)
    auth_domain = _auth_domain(garmin_credentials.is_cn)

    db_con = ensure_vendor_sync_table(str(runtime_config.sql_file))
    activities_df = _load_local_activities(db_con)
    if activities_df.empty:
        logger.info("No activities found in DuckDB for account=%s.", account)
        db_con.close()
        return

    garmin_reader = Garmin(garmin_credentials.secret_string, auth_domain)
    try:
        garmin_activities = await _fetch_garmin_activities(garmin_reader)
    finally:
        await garmin_reader.req.aclose()

    logger.info("Loaded %d Garmin activities for reconcile.", len(garmin_activities))
    _reconcile_rows(
        db_con=db_con,
        activities_df=activities_df,
        garmin_activities=garmin_activities,
        account=account,
        match_window_seconds=match_window_seconds,
        distance_tolerance_meters=distance_tolerance_meters,
        duration_tolerance_seconds=duration_tolerance_seconds,
    )
    db_con.close()


def run_reconcile_garmin_sync(
    *,
    garmin_credentials: GarminCredentials,
    runtime_config: RuntimeConfig,
    match_window_seconds: int,
    distance_tolerance_meters: float,
    duration_tolerance_seconds: int,
) -> None:
    asyncio.run(
        run_reconcile_garmin(
            garmin_credentials=garmin_credentials,
            runtime_config=runtime_config,
            match_window_seconds=match_window_seconds,
            distance_tolerance_meters=distance_tolerance_meters,
            duration_tolerance_seconds=duration_tolerance_seconds,
        )
    )


async def run_sync_garmin(
    *,
    garmin_credentials: GarminCredentials,
    runtime_config: RuntimeConfig,
    use_fake_garmin_device: bool,
    fix_hr: bool,
    force: bool,
    match_window_seconds: int,
    distance_tolerance_meters: float,
    duration_tolerance_seconds: int,
) -> None:
    account = _account_name(garmin_credentials.is_cn)
    auth_domain = _auth_domain(garmin_credentials.is_cn)

    db_con = ensure_vendor_sync_table(str(runtime_config.sql_file))
    generator = Generator(runtime_config.sql_file)
    activities_df = _load_local_activities(db_con)

    if activities_df.empty:
        logger.info("No activities found in DuckDB for account=%s.", account)
        db_con.close()
        return

    garmin_reader = Garmin(garmin_credentials.secret_string, auth_domain)
    try:
        garmin_activities = await _fetch_garmin_activities(garmin_reader)
        if force:
            deleted = await _delete_all_garmin_activities(garmin_reader, garmin_activities)
            logger.info("Force mode enabled: deleted %d remote Garmin activities for %s.", deleted, account)
            garmin_activities = []
    finally:
        await garmin_reader.req.aclose()

    if force:
        db_con.execute(
            "DELETE FROM vendor_activity_sync WHERE vendor = ? AND account = ?",
            [VENDOR_NAME, account],
        )
        logger.info("Force mode enabled: cleared local sync status for %s.", account)

    _reconcile_rows(
        db_con=db_con,
        activities_df=activities_df,
        garmin_activities=garmin_activities,
        account=account,
        match_window_seconds=match_window_seconds,
        distance_tolerance_meters=distance_tolerance_meters,
        duration_tolerance_seconds=duration_tolerance_seconds,
    )

    state_map = load_vendor_sync_rows(db_con, vendor=VENDOR_NAME, account=account)
    no_flyby_type_counts: dict[str, int] = {}
    reserved_remote_ids = {
        int(row.remote_activity_id)
        for row in state_map.values()
        if row.status in SYNCED_STATUSES and row.remote_activity_id is not None
    }

    for _, activity_row in activities_df.iterrows():
        activity_id = int(activity_row["run_id"])

        flyby_df = db_con.execute(
            "SELECT * FROM activities_flyby WHERE activity_id = ? ORDER BY time_offset",
            [activity_id],
        ).fetchdf()
        if flyby_df.empty:
            activity_type = str(activity_row.get("type") or "Unknown")
            no_flyby_type_counts[activity_type] = no_flyby_type_counts.get(activity_type, 0) + 1

        content_hash = _activity_content_hash(activity_row, flyby_df)
        state = state_map.get(activity_id)
        if not force and state and state.status in SYNCED_STATUSES and state.content_hash == content_hash:
            continue

        try:
            if not force:
                existing_garmin_id = _is_existing_in_garmin(
                    activity_row,
                    garmin_activities,
                    match_window_seconds=match_window_seconds,
                    distance_tolerance_meters=distance_tolerance_meters,
                    duration_tolerance_seconds=duration_tolerance_seconds,
                    reserved_activity_ids=reserved_remote_ids,
                )
                if existing_garmin_id is not None:
                    reserved_remote_ids.add(existing_garmin_id)
                    upsert_vendor_sync_status(
                        db_con,
                        activity_id=activity_id,
                        vendor=VENDOR_NAME,
                        account=account,
                        status="synced",
                        remote_activity_id=existing_garmin_id,
                        content_hash=content_hash,
                        last_error=None,
                        attempt_count=state.attempt_count if state else 0,
                        last_verified_at=datetime.now(tz=timezone.utc),
                    )
                    continue

                # If an equivalent remote activity exists but has been reserved by another local activity in this run,
                # mark conflict instead of uploading duplicates.
                reserved_match = _is_existing_in_garmin(
                    activity_row,
                    garmin_activities,
                    match_window_seconds=match_window_seconds,
                    distance_tolerance_meters=distance_tolerance_meters,
                    duration_tolerance_seconds=duration_tolerance_seconds,
                    reserved_activity_ids=set(),
                )
                if reserved_match is not None and reserved_match in reserved_remote_ids:
                    upsert_vendor_sync_status(
                        db_con,
                        activity_id=activity_id,
                        vendor=VENDOR_NAME,
                        account=account,
                        status="conflict",
                        remote_activity_id=reserved_match,
                        content_hash=content_hash,
                        last_error="Matched remote activity already reserved by another local activity.",
                        attempt_count=state.attempt_count if state else 0,
                    )
                    continue

            upsert_vendor_sync_status(
                db_con,
                activity_id=activity_id,
                vendor=VENDOR_NAME,
                account=account,
                status="uploading",
                content_hash=content_hash,
                attempt_count=state.attempt_count if state else 0,
            )

            dataframes = construct_dataframes(activity_row, flyby_df)
            fit_bytes = generator.build_fit_file_from_dataframes(dataframes)
            fit_record = FIT_UPLOAD_RECORD(filename=f"{activity_id}.fit", content=[fit_bytes])

            garmin_uploader = Garmin(garmin_credentials.secret_string, auth_domain)
            try:
                upload_results = await garmin_uploader.upload_activities_original_from_strava(
                    [fit_record],
                    use_fake_garmin_device=use_fake_garmin_device,
                    fix_hr=fix_hr,
                )
            finally:
                if not garmin_uploader.req.is_closed:
                    await garmin_uploader.req.aclose()

            remote_activity_id = None
            if upload_results:
                remote_activity_id = _extract_remote_activity_id_from_upload_result(upload_results[0])

            # Some Garmin responses do not include an activity id. Re-fetch latest records as fallback.
            if remote_activity_id is None:
                garmin_reader = Garmin(garmin_credentials.secret_string, auth_domain)
                try:
                    recent_activities = await _fetch_garmin_activities(garmin_reader, page_size=50, max_pages=2)
                finally:
                    await garmin_reader.req.aclose()
                garmin_activities = recent_activities
                remote_activity_id = _is_existing_in_garmin(
                    activity_row,
                    recent_activities,
                    match_window_seconds=match_window_seconds,
                    distance_tolerance_meters=distance_tolerance_meters,
                    duration_tolerance_seconds=duration_tolerance_seconds,
                    reserved_activity_ids=reserved_remote_ids,
                )

            if remote_activity_id is not None:
                reserved_remote_ids.add(remote_activity_id)

            upsert_vendor_sync_status(
                db_con,
                activity_id=activity_id,
                vendor=VENDOR_NAME,
                account=account,
                status="synced",
                remote_activity_id=remote_activity_id,
                content_hash=content_hash,
                last_error=None,
                attempt_count=state.attempt_count if state else 0,
                uploaded_at=datetime.now(tz=timezone.utc),
            )
            logger.info("Synced activity %s to %s.", activity_id, account)
        except Exception as exc:
            next_attempt = (state.attempt_count if state else 0) + 1
            upsert_vendor_sync_status(
                db_con,
                activity_id=activity_id,
                vendor=VENDOR_NAME,
                account=account,
                status="failed",
                content_hash=content_hash,
                last_error=str(exc),
                attempt_count=next_attempt,
            )
            logger.error("Failed syncing activity %s to %s: %s", activity_id, account, exc, exc_info=True)

        state_map = load_vendor_sync_rows(db_con, vendor=VENDOR_NAME, account=account)

    if no_flyby_type_counts:
        logger.info("Activities without activities_flyby were processed as summary-only FIT files:")
        for activity_type, count in sorted(no_flyby_type_counts.items(), key=lambda item: item[0]):
            logger.info("  %s: %d", activity_type, count)

    db_con.close()


def run_sync_garmin_sync(
    *,
    garmin_credentials: GarminCredentials,
    runtime_config: RuntimeConfig,
    use_fake_garmin_device: bool,
    fix_hr: bool,
    force: bool,
    match_window_seconds: int,
    distance_tolerance_meters: float,
    duration_tolerance_seconds: int,
) -> None:
    asyncio.run(
        run_sync_garmin(
            garmin_credentials=garmin_credentials,
            runtime_config=runtime_config,
            use_fake_garmin_device=use_fake_garmin_device,
            fix_hr=fix_hr,
            force=force,
            match_window_seconds=match_window_seconds,
            distance_tolerance_meters=distance_tolerance_meters,
            duration_tolerance_seconds=duration_tolerance_seconds,
        )
    )

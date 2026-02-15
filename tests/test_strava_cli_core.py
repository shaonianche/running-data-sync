import asyncio
from datetime import datetime, timezone
from unittest.mock import patch

import pytest

from scripts.strava_cli_core.cli import _parse_range, build_parser
from scripts.strava_cli_core.config import CredentialInput, resolve_garmin_credentials, resolve_strava_credentials
from scripts.strava_cli_core.store import (
    ensure_vendor_sync_table,
    load_vendor_status_counts,
    load_vendor_sync_rows,
    retry_failed_sync_rows,
    upsert_vendor_sync_status,
)
from scripts.strava_cli_core.sync_garmin import (
    _extract_remote_activity_id_from_upload_result,
    _fetch_garmin_activities,
    _is_existing_in_garmin,
)
from scripts.strava_cli_core.upload_files import collect_activity_files


def test_resolve_strava_credentials_from_args():
    credentials = resolve_strava_credentials(
        CredentialInput(
            client_id="id",
            client_secret="secret",
            refresh_token="token",
        )
    )
    assert credentials.client_id == "id"
    assert credentials.client_secret == "secret"
    assert credentials.refresh_token == "token"


def test_resolve_strava_credentials_fallback_to_env():
    with patch("scripts.strava_cli_core.config.load_env_config") as mock_load_env:
        mock_load_env.return_value = {
            "strava_client_id": "env-id",
            "strava_client_secret": "env-secret",
            "strava_refresh_token": "env-token",
        }
        credentials = resolve_strava_credentials(CredentialInput())
        assert credentials.client_id == "env-id"
        assert credentials.client_secret == "env-secret"
        assert credentials.refresh_token == "env-token"


def test_resolve_strava_credentials_missing_raises():
    with patch("scripts.strava_cli_core.config.load_env_config") as mock_load_env:
        mock_load_env.return_value = {}
        with pytest.raises(ValueError):
            resolve_strava_credentials(CredentialInput())


def test_resolve_garmin_credentials_with_cn_env():
    with patch("scripts.strava_cli_core.config.load_env_config") as mock_load_env:
        mock_load_env.return_value = {
            "garmin_secret_cn": "cn-secret",
            "garmin_secret": "com-secret",
        }
        credentials = resolve_garmin_credentials(CredentialInput(is_cn=True))
        assert credentials.secret_string == "cn-secret"
        assert credentials.is_cn is True


def test_parse_range():
    assert _parse_range("10:20") == (10, 20)
    assert _parse_range(None) is None
    with pytest.raises(ValueError):
        _parse_range("20:10")
    with pytest.raises(ValueError):
        _parse_range("invalid")


def test_strava_cli_parser_sync_db():
    parser = build_parser()
    args = parser.parse_args(["sync", "db", "--force"])
    assert args.command == "sync"
    assert args.sync_target == "db"
    assert args.force is True
    assert args.prune is False


def test_strava_cli_parser_sync_db_prune():
    parser = build_parser()
    args = parser.parse_args(["sync", "db", "--prune"])
    assert args.command == "sync"
    assert args.sync_target == "db"
    assert args.prune is True


def test_strava_cli_parser_export():
    parser = build_parser()
    args = parser.parse_args(["export", "--format", "fit", "--id", "123", "--id-range", "100:200"])
    assert args.command == "export"
    assert args.format == "fit"
    assert args.ids == [123]
    assert args.id_range == "100:200"


def test_strava_cli_parser_garmin_files():
    parser = build_parser()
    args = parser.parse_args(["vendor", "garmin-files", "--secret-string", "secret", "data/FIT_OUT", "--recursive"])
    assert args.command == "vendor"
    assert args.vendor_target == "garmin-files"
    assert args.secret_string == "secret"
    assert args.recursive is True


def test_strava_cli_parser_sync_garmin_does_not_require_strava_credentials():
    parser = build_parser()
    args = parser.parse_args(["vendor", "garmin", "--is-cn", "--secret-string", "secret"])
    assert args.command == "vendor"
    assert args.vendor_target == "garmin"
    assert args.secret_string == "secret"
    assert args.is_cn is True
    assert args.duration_tolerance_sec == 120
    assert args.force is False
    assert not hasattr(args, "client_id")
    assert not hasattr(args, "client_secret")
    assert not hasattr(args, "refresh_token")


def test_strava_cli_parser_sync_garmin_force():
    parser = build_parser()
    args = parser.parse_args(["vendor", "garmin", "--secret-string", "secret", "-f"])
    assert args.command == "vendor"
    assert args.vendor_target == "garmin"
    assert args.force is True


def test_strava_cli_parser_garmin_reconcile():
    parser = build_parser()
    args = parser.parse_args(["vendor", "garmin-reconcile", "--is-cn", "--secret-string", "secret"])
    assert args.command == "vendor"
    assert args.vendor_target == "garmin-reconcile"
    assert args.secret_string == "secret"
    assert args.is_cn is True
    assert args.duration_tolerance_sec == 120


def test_strava_cli_parser_vendor_status_retry_failed():
    parser = build_parser()
    args = parser.parse_args(["vendor", "status", "--retry-failed", "--is-cn"])
    assert args.command == "vendor"
    assert args.vendor_target == "status"
    assert args.vendor == "garmin"
    assert args.retry_failed is True
    assert args.is_cn is True


def test_collect_activity_files_filters_supported_extensions(temp_dir):
    fit_file = temp_dir / "a.fit"
    gpx_file = temp_dir / "b.gpx"
    tcx_file = temp_dir / "c.tcx"
    txt_file = temp_dir / "d.txt"
    fit_file.write_text("fit")
    gpx_file.write_text("gpx")
    tcx_file.write_text("tcx")
    txt_file.write_text("txt")

    files = collect_activity_files([temp_dir])
    assert files == sorted([fit_file.resolve(), gpx_file.resolve(), tcx_file.resolve()])


def test_collect_activity_files_raises_when_empty(temp_dir):
    text_file = temp_dir / "a.txt"
    text_file.write_text("x")
    with pytest.raises(ValueError):
        collect_activity_files([temp_dir])


def test_sync_store_roundtrip(temp_dir):
    db_path = temp_dir / "sync.duckdb"
    con = ensure_vendor_sync_table(str(db_path))
    try:
        upsert_vendor_sync_status(
            con,
            activity_id=1001,
            vendor="garmin",
            account="garmin_com",
            status="synced",
            remote_activity_id=9001,
        )
        upsert_vendor_sync_status(
            con,
            activity_id=1002,
            vendor="garmin",
            account="garmin_com",
            status="failed",
            last_error="network error",
        )
        rows = load_vendor_sync_rows(con, vendor="garmin", account="garmin_com")
        assert rows[1001].status == "synced"
        assert rows[1001].remote_activity_id == 9001
        assert rows[1002].status == "failed"

        retried = retry_failed_sync_rows(con, vendor="garmin", account="garmin_com")
        assert retried == 1

        rows = load_vendor_sync_rows(con, vendor="garmin", account="garmin_com")
        assert rows[1002].status == "pending"

        counts = load_vendor_status_counts(con, vendor="garmin", account="garmin_com")
        assert counts["pending"] == 1
        assert counts["synced"] == 1
    finally:
        con.close()


def test_is_existing_in_garmin_matches_by_time_and_distance():
    activity_row = {
        "start_date": datetime(2026, 2, 15, 8, 0, 0, tzinfo=timezone.utc),
        "distance": 10000.0,
    }

    garmin_activities = [
        {
            "activityId": 1,
            "startTimeGMT": "2026-02-15 07:59:30",
            "distance": 9980.0,
        },
        {
            "activityId": 2,
            "startTimeGMT": "2026-02-14 07:59:30",
            "distance": 9980.0,
        },
    ]

    matched = _is_existing_in_garmin(
        activity_row,
        garmin_activities,
        match_window_seconds=120,
        distance_tolerance_meters=50.0,
        duration_tolerance_seconds=120,
    )
    assert matched == 1


def test_is_existing_in_garmin_distance_mode_filters_by_type():
    activity_row = {
        "start_date": datetime(2026, 2, 15, 8, 0, 0, tzinfo=timezone.utc),
        "distance": 10000.0,
        "elapsed_time": 2400.0,
        "type": "Run",
    }
    garmin_activities = [
        {
            "activityId": 51,
            "startTimeGMT": "2026-02-15 08:00:20",
            "distance": 9998.0,
            "activityType": {"typeKey": "cycling"},
        },
        {
            "activityId": 52,
            "startTimeGMT": "2026-02-15 08:00:30",
            "distance": 9995.0,
            "activityType": {"typeKey": "street_running"},
        },
    ]
    matched = _is_existing_in_garmin(
        activity_row,
        garmin_activities,
        match_window_seconds=120,
        distance_tolerance_meters=50.0,
        duration_tolerance_seconds=120,
    )
    assert matched == 52


def test_is_existing_in_garmin_uses_best_candidate_and_reservation():
    activity_row = {
        "start_date": datetime(2026, 2, 15, 8, 0, 0, tzinfo=timezone.utc),
        "distance": 2400.0,
        "elapsed_time": 980.0,
        "type": "Run",
    }
    garmin_activities = [
        {
            "activityId": 30,
            "startTimeGMT": "2026-02-15 08:02:00",
            "distance": 2410.0,
            "duration": 980.0,
            "activityType": {"typeKey": "street_running"},
        },
        {
            "activityId": 31,
            "startTimeGMT": "2026-02-15 08:00:30",
            "distance": 2399.0,
            "duration": 980.0,
            "activityType": {"typeKey": "street_running"},
        },
    ]
    best = _is_existing_in_garmin(
        activity_row,
        garmin_activities,
        match_window_seconds=180,
        distance_tolerance_meters=50.0,
        duration_tolerance_seconds=120,
    )
    assert best == 31

    reserved = _is_existing_in_garmin(
        activity_row,
        garmin_activities,
        match_window_seconds=180,
        distance_tolerance_meters=50.0,
        duration_tolerance_seconds=120,
        reserved_activity_ids={31},
    )
    assert reserved == 30


def test_is_existing_in_garmin_accepts_street_running_for_run():
    activity_row = {
        "start_date": datetime(2026, 2, 15, 8, 0, 0, tzinfo=timezone.utc),
        "distance": 2400.0,
        "elapsed_time": 980.0,
        "type": "Run",
    }
    garmin_activities = [
        {
            "activityId": 21,
            "startTimeGMT": "2026-02-15 08:00:00",
            "distance": 2398.0,
            "duration": 980.0,
            "activityType": {"typeKey": "street_running"},
        },
    ]
    matched = _is_existing_in_garmin(
        activity_row,
        garmin_activities,
        match_window_seconds=120,
        distance_tolerance_meters=50.0,
        duration_tolerance_seconds=120,
    )
    assert matched == 21


def test_is_existing_in_garmin_matches_stationary_by_time_duration_and_type():
    activity_row = {
        "start_date": datetime(2026, 2, 15, 8, 0, 0, tzinfo=timezone.utc),
        "distance": 0.0,
        "elapsed_time": 1800.0,
        "type": "WeightTraining",
    }
    garmin_activities = [
        {
            "activityId": 11,
            "startTimeGMT": "2026-02-15 08:01:00",
            "distance": 0.0,
            "duration": 1790.0,
            "activityType": {"typeKey": "strength_training"},
        },
        {
            "activityId": 12,
            "startTimeGMT": "2026-02-15 08:01:00",
            "distance": 0.0,
            "duration": 1790.0,
            "activityType": {"typeKey": "running"},
        },
    ]
    matched = _is_existing_in_garmin(
        activity_row,
        garmin_activities,
        match_window_seconds=120,
        distance_tolerance_meters=50.0,
        duration_tolerance_seconds=120,
    )
    assert matched == 11


def test_is_existing_in_garmin_matches_boxing_for_workout():
    activity_row = {
        "start_date": datetime(2026, 2, 15, 8, 0, 0, tzinfo=timezone.utc),
        "distance": 0.0,
        "elapsed_time": 1800.0,
        "type": "Workout",
    }
    garmin_activities = [
        {
            "activityId": 41,
            "startTimeGMT": "2026-02-15 08:00:00",
            "distance": 0.0,
            "duration": 1800.0,
            "activityType": {"typeKey": "boxing"},
        },
    ]
    matched = _is_existing_in_garmin(
        activity_row,
        garmin_activities,
        match_window_seconds=120,
        distance_tolerance_meters=50.0,
        duration_tolerance_seconds=120,
    )
    assert matched == 41


def test_is_existing_in_garmin_prefers_duration_for_boxing_type():
    activity_row = {
        "start_date": datetime(2026, 2, 15, 8, 0, 0, tzinfo=timezone.utc),
        "distance": 2000.0,
        "elapsed_time": 1800.0,
        "type": "Boxing",
    }
    garmin_activities = [
        {
            "activityId": 61,
            "startTimeGMT": "2026-02-15 08:00:00",
            "distance": 500.0,
            "duration": 1795.0,
            "activityType": {"typeKey": "boxing"},
        },
    ]
    matched = _is_existing_in_garmin(
        activity_row,
        garmin_activities,
        match_window_seconds=120,
        distance_tolerance_meters=50.0,
        duration_tolerance_seconds=120,
    )
    assert matched == 61


def test_extract_remote_activity_id_from_upload_result():
    payload = {
        "uploadId": "x1",
        "detailedImportResult": {
            "status": "SUCCESS",
            "summary": {"activityId": 123456789},
        },
    }
    assert _extract_remote_activity_id_from_upload_result(payload) == 123456789


def test_fetch_garmin_activities_without_max_pages_fetches_until_empty():
    class DummyGarmin:
        def __init__(self):
            self.calls = []

        async def get_activities(self, start, limit):
            self.calls.append((start, limit))
            if start == 0:
                return [{"activityId": 1}]
            if start == 1:
                return [{"activityId": 2}]
            return []

    async def run():
        client = DummyGarmin()
        rows = await _fetch_garmin_activities(client, page_size=1, max_pages=None)
        return rows, client.calls

    rows, calls = asyncio.run(run())
    assert [row["activityId"] for row in rows] == [1, 2]
    assert calls == [(0, 1), (1, 1), (2, 1)]

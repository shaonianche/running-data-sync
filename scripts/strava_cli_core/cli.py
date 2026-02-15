from __future__ import annotations

import argparse
import sys
from pathlib import Path

from ..utils import get_logger
from .config import CredentialInput, get_runtime_config, resolve_garmin_credentials, resolve_strava_credentials
from .export import run_export
from .status import run_vendor_status
from .sync_db import run_sync_db
from .sync_garmin import run_reconcile_garmin_sync, run_sync_garmin_sync
from .upload_files import run_upload_files_to_garmin_sync

logger = get_logger(__name__)


def _add_strava_auth_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--client-id", dest="client_id", help="Strava client id")
    parser.add_argument("--client-secret", dest="client_secret", help="Strava client secret")
    parser.add_argument("--refresh-token", dest="refresh_token", help="Strava refresh token")


def _build_sync_subcommands(subparsers) -> None:
    sync_parser = subparsers.add_parser("sync", help="Sync commands")
    sync_subparsers = sync_parser.add_subparsers(dest="sync_target", required=True)

    sync_db = sync_subparsers.add_parser("db", help="Sync Strava data to DuckDB")
    _add_strava_auth_args(sync_db)
    sync_db.add_argument("--force", action="store_true", help="Force full resync from Strava API")
    sync_db.add_argument(
        "--prune",
        action="store_true",
        help="Remove local activities not present in current Strava account (also deletes activities_flyby).",
    )
    sync_db.set_defaults(handler=_handle_sync_db)


def _build_vendor_subcommands(subparsers) -> None:
    vendor_parser = subparsers.add_parser("vendor", help="Sync DuckDB data to external platforms")
    vendor_subparsers = vendor_parser.add_subparsers(dest="vendor_target", required=True)

    vendor_garmin = vendor_subparsers.add_parser("garmin", help="Sync DuckDB activities to Garmin/Garmin CN")
    vendor_garmin.add_argument("--secret-string", dest="secret_string", help="Garmin secret string")
    vendor_garmin.add_argument("--is-cn", action="store_true", help="Use Garmin CN account")
    vendor_garmin.add_argument("--use-fake-garmin-device", action="store_true", default=False)
    vendor_garmin.add_argument("--fix-hr", action="store_true", default=False)
    vendor_garmin.add_argument(
        "-f",
        "--force",
        action="store_true",
        help="Force full resync by deleting all remote Garmin activities first",
    )
    vendor_garmin.add_argument("--match-window-sec", type=int, default=300)
    vendor_garmin.add_argument("--distance-tolerance-m", type=float, default=50.0)
    vendor_garmin.add_argument("--duration-tolerance-sec", type=int, default=120)
    vendor_garmin.set_defaults(handler=_handle_sync_garmin)

    vendor_garmin_reconcile = vendor_subparsers.add_parser(
        "garmin-reconcile",
        help="Reconcile DuckDB activities with Garmin activities and update sync status",
    )
    vendor_garmin_reconcile.add_argument("--secret-string", dest="secret_string", help="Garmin secret string")
    vendor_garmin_reconcile.add_argument("--is-cn", action="store_true", help="Use Garmin CN account")
    vendor_garmin_reconcile.add_argument("--match-window-sec", type=int, default=300)
    vendor_garmin_reconcile.add_argument("--distance-tolerance-m", type=float, default=50.0)
    vendor_garmin_reconcile.add_argument("--duration-tolerance-sec", type=int, default=120)
    vendor_garmin_reconcile.set_defaults(handler=_handle_reconcile_garmin)

    vendor_status = vendor_subparsers.add_parser("status", help="Show vendor sync status summary")
    vendor_status.add_argument("--vendor", default="garmin", help="Vendor name")
    vendor_status.add_argument("--account", help="Vendor account identifier, e.g. garmin_com")
    vendor_status.add_argument("--is-cn", action="store_true", help="Use Garmin CN account when vendor is garmin")
    vendor_status.add_argument("--retry-failed", action="store_true", help="Reset failed records to pending")
    vendor_status.set_defaults(handler=_handle_vendor_status)

    upload_files = vendor_subparsers.add_parser("garmin-files", help="Upload local fit/gpx/tcx files to Garmin")
    upload_files.add_argument("--secret-string", dest="secret_string", help="Garmin secret string")
    upload_files.add_argument(
        "paths",
        nargs="+",
        type=Path,
        help="Files or directories containing .fit/.gpx/.tcx files",
    )
    upload_files.add_argument("--is-cn", action="store_true", help="Use Garmin CN account")
    upload_files.add_argument("--recursive", action="store_true", help="Recursively scan directories")
    upload_files.set_defaults(handler=_handle_upload_files)


def _build_export_subcommand(subparsers) -> None:
    export_parser = subparsers.add_parser("export", help="Export Strava activities to files")
    export_parser.add_argument("--format", choices=["fit", "tcx", "gpx"], required=True)
    export_parser.add_argument("--all", action="store_true", help="Export all activities")
    export_parser.add_argument("--id", action="append", dest="ids", type=int, default=[], help="Activity id")
    export_parser.add_argument("--id-range", help="Activity id range, e.g. 100:200")
    export_parser.add_argument("--output-dir", type=Path, help="Output directory")
    export_parser.set_defaults(handler=_handle_export)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="strava-cli", description="Unified Strava CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)
    _build_sync_subcommands(subparsers)
    _build_vendor_subcommands(subparsers)
    _build_export_subcommand(subparsers)
    return parser


def _parse_range(raw: str | None) -> tuple[int, int] | None:
    if not raw:
        return None
    parts = raw.split(":", maxsplit=1)
    if len(parts) != 2:
        raise ValueError("--id-range must be in start:end format")
    start, end = int(parts[0]), int(parts[1])
    if start > end:
        raise ValueError("--id-range start must be <= end")
    return (start, end)


def _credential_input_from_args(args: argparse.Namespace) -> CredentialInput:
    return CredentialInput(
        client_id=getattr(args, "client_id", None),
        client_secret=getattr(args, "client_secret", None),
        refresh_token=getattr(args, "refresh_token", None),
        garmin_secret=getattr(args, "secret_string", None),
        is_cn=getattr(args, "is_cn", False),
    )


def _handle_sync_db(args: argparse.Namespace) -> None:
    credentials = resolve_strava_credentials(_credential_input_from_args(args))
    run_sync_db(credentials, force=args.force, prune=args.prune)


def _handle_sync_garmin(args: argparse.Namespace) -> None:
    input_data = _credential_input_from_args(args)
    garmin_credentials = resolve_garmin_credentials(input_data)
    run_sync_garmin_sync(
        garmin_credentials=garmin_credentials,
        runtime_config=get_runtime_config(),
        use_fake_garmin_device=args.use_fake_garmin_device,
        fix_hr=args.fix_hr,
        force=args.force,
        match_window_seconds=args.match_window_sec,
        distance_tolerance_meters=args.distance_tolerance_m,
        duration_tolerance_seconds=args.duration_tolerance_sec,
    )


def _handle_reconcile_garmin(args: argparse.Namespace) -> None:
    input_data = _credential_input_from_args(args)
    garmin_credentials = resolve_garmin_credentials(input_data)
    run_reconcile_garmin_sync(
        garmin_credentials=garmin_credentials,
        runtime_config=get_runtime_config(),
        match_window_seconds=args.match_window_sec,
        distance_tolerance_meters=args.distance_tolerance_m,
        duration_tolerance_seconds=args.duration_tolerance_sec,
    )


def _handle_vendor_status(args: argparse.Namespace) -> None:
    run_vendor_status(
        runtime_config=get_runtime_config(),
        vendor=args.vendor,
        account=args.account,
        is_cn=args.is_cn,
        retry_failed=args.retry_failed,
    )


def _handle_export(args: argparse.Namespace) -> None:
    run_export(
        runtime_config=get_runtime_config(),
        export_format=args.format,
        export_all=args.all,
        include_ids=args.ids,
        id_range=_parse_range(args.id_range),
        output_dir=args.output_dir,
    )


def _handle_upload_files(args: argparse.Namespace) -> None:
    input_data = _credential_input_from_args(args)
    garmin_credentials = resolve_garmin_credentials(input_data)
    run_upload_files_to_garmin_sync(
        garmin_credentials=garmin_credentials,
        paths=args.paths,
        recursive=args.recursive,
    )


def main() -> None:
    parser = build_parser()
    if len(sys.argv) == 1:
        _print_full_help(parser)
        return

    args = parser.parse_args()
    try:
        args.handler(args)
    except Exception as exc:
        logger.error("Command failed: %s", exc, exc_info=True)
        raise SystemExit(1) from exc


def _print_full_help(parser: argparse.ArgumentParser) -> None:
    parser.print_help()
    for action in parser._actions:
        if not isinstance(action, argparse._SubParsersAction):
            continue
        for name, subparser in action.choices.items():
            print(f"\n[{name}]")
            subparser.print_help()
            for sub_action in subparser._actions:
                if not isinstance(sub_action, argparse._SubParsersAction):
                    continue
                for sub_name, nested in sub_action.choices.items():
                    print(f"\n[{name} {sub_name}]")
                    nested.print_help()

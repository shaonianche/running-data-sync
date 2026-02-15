from __future__ import annotations

from ..utils import get_logger
from .store import ensure_vendor_sync_table, load_vendor_status_counts, retry_failed_sync_rows
from .types import RuntimeConfig

logger = get_logger(__name__)


def _resolve_account(vendor: str, account: str | None, is_cn: bool) -> str | None:
    if account:
        return account
    if vendor == "garmin":
        return "garmin_cn" if is_cn else "garmin_com"
    return None


def run_vendor_status(
    *,
    runtime_config: RuntimeConfig,
    vendor: str,
    account: str | None,
    is_cn: bool,
    retry_failed: bool,
) -> None:
    target_account = _resolve_account(vendor, account, is_cn)

    con = ensure_vendor_sync_table(str(runtime_config.sql_file))
    try:
        if retry_failed:
            retried = retry_failed_sync_rows(con, vendor=vendor, account=target_account)
            logger.info("Reset %d failed row(s) to pending for vendor=%s account=%s.", retried, vendor, target_account)

        counts = load_vendor_status_counts(con, vendor=vendor, account=target_account)
    finally:
        con.close()

    scope = f"vendor={vendor}" if target_account is None else f"vendor={vendor} account={target_account}"
    total = sum(counts.values())
    logger.info("Vendor sync status summary (%s): total=%d", scope, total)
    if not counts:
        logger.info("No sync status rows found.")
        return

    for status, count in counts.items():
        logger.info("  %s: %d", status, count)

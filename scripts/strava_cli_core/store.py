from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

import duckdb

from ..generator.db import get_db_connection

SYNCED_STATUSES = {"synced", "skipped_exists"}


@dataclass(frozen=True)
class VendorSyncRow:
    activity_id: int
    vendor: str
    account: str
    status: str
    remote_activity_id: int | None
    content_hash: str | None
    last_error: str | None
    attempt_count: int
    next_retry_at: datetime | None
    uploaded_at: datetime | None
    last_verified_at: datetime | None


def ensure_vendor_sync_table(db_path: str) -> duckdb.DuckDBPyConnection:
    con = get_db_connection(db_path, read_only=False)
    con.execute(
        """
        CREATE TABLE IF NOT EXISTS vendor_activity_sync (
            activity_id BIGINT NOT NULL,
            vendor VARCHAR NOT NULL,
            account VARCHAR NOT NULL,
            status VARCHAR NOT NULL,
            remote_activity_id BIGINT,
            content_hash VARCHAR,
            last_error VARCHAR,
            attempt_count INTEGER NOT NULL DEFAULT 0,
            next_retry_at TIMESTAMP,
            uploaded_at TIMESTAMP,
            last_verified_at TIMESTAMP,
            updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
            PRIMARY KEY (activity_id, vendor, account)
        )
        """
    )
    return con


def load_vendor_sync_rows(
    con: duckdb.DuckDBPyConnection,
    *,
    vendor: str,
    account: str,
) -> dict[int, VendorSyncRow]:
    rows = con.execute(
        """
        SELECT
            activity_id,
            vendor,
            account,
            status,
            remote_activity_id,
            content_hash,
            last_error,
            attempt_count,
            next_retry_at,
            uploaded_at,
            last_verified_at
        FROM vendor_activity_sync
        WHERE vendor = ? AND account = ?
        """,
        [vendor, account],
    ).fetchall()

    result: dict[int, VendorSyncRow] = {}
    for row in rows:
        result[int(row[0])] = VendorSyncRow(
            activity_id=int(row[0]),
            vendor=str(row[1]),
            account=str(row[2]),
            status=str(row[3]),
            remote_activity_id=int(row[4]) if row[4] is not None else None,
            content_hash=str(row[5]) if row[5] is not None else None,
            last_error=str(row[6]) if row[6] is not None else None,
            attempt_count=int(row[7] or 0),
            next_retry_at=row[8],
            uploaded_at=row[9],
            last_verified_at=row[10],
        )
    return result


def upsert_vendor_sync_status(
    con: duckdb.DuckDBPyConnection,
    *,
    activity_id: int,
    vendor: str,
    account: str,
    status: str,
    remote_activity_id: int | None = None,
    content_hash: str | None = None,
    last_error: str | None = None,
    attempt_count: int | None = None,
    next_retry_at: datetime | None = None,
    uploaded_at: datetime | None = None,
    last_verified_at: datetime | None = None,
) -> None:
    con.execute(
        """
        INSERT INTO vendor_activity_sync (
            activity_id,
            vendor,
            account,
            status,
            remote_activity_id,
            content_hash,
            last_error,
            attempt_count,
            next_retry_at,
            uploaded_at,
            last_verified_at,
            updated_at
        )
        VALUES (
            ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 0), ?, ?, ?, NOW()
        )
        ON CONFLICT (activity_id, vendor, account) DO UPDATE
        SET
            status = excluded.status,
            remote_activity_id = COALESCE(excluded.remote_activity_id, vendor_activity_sync.remote_activity_id),
            content_hash = COALESCE(excluded.content_hash, vendor_activity_sync.content_hash),
            last_error = excluded.last_error,
            attempt_count = COALESCE(excluded.attempt_count, vendor_activity_sync.attempt_count),
            next_retry_at = excluded.next_retry_at,
            uploaded_at = COALESCE(excluded.uploaded_at, vendor_activity_sync.uploaded_at),
            last_verified_at = COALESCE(excluded.last_verified_at, vendor_activity_sync.last_verified_at),
            updated_at = NOW()
        """,
        [
            activity_id,
            vendor,
            account,
            status,
            remote_activity_id,
            content_hash,
            last_error,
            attempt_count,
            next_retry_at,
            uploaded_at,
            last_verified_at,
        ],
    )


def retry_failed_sync_rows(
    con: duckdb.DuckDBPyConnection,
    *,
    vendor: str,
    account: str | None = None,
) -> int:
    where_clause = "vendor = ? AND status = 'failed'"
    params: list[str] = [vendor]
    if account:
        where_clause += " AND account = ?"
        params.append(account)

    failed_count = con.execute(
        f"SELECT COUNT(*) FROM vendor_activity_sync WHERE {where_clause}",
        params,
    ).fetchone()
    retry_count = int(failed_count[0]) if failed_count else 0
    if retry_count == 0:
        return 0

    con.execute(
        f"""
        UPDATE vendor_activity_sync
        SET status = 'pending',
            last_error = NULL,
            next_retry_at = NULL,
            updated_at = NOW()
        WHERE {where_clause}
        """,
        params,
    )
    return retry_count


def load_vendor_status_counts(
    con: duckdb.DuckDBPyConnection,
    *,
    vendor: str,
    account: str | None = None,
) -> dict[str, int]:
    where_clause = "vendor = ?"
    params: list[str] = [vendor]
    if account:
        where_clause += " AND account = ?"
        params.append(account)

    rows = con.execute(
        f"""
        SELECT status, COUNT(*)
        FROM vendor_activity_sync
        WHERE {where_clause}
        GROUP BY status
        ORDER BY status
        """,
        params,
    ).fetchall()
    return {str(status): int(count) for status, count in rows}

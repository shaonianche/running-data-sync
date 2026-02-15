import json
from pathlib import Path

import duckdb

from .config import DB_FOLDER, JSON_FILE, SQL_FILE
from .generator.db import get_db_connection
from .utils import get_logger

logger = get_logger(__name__)


def validate_data_consistency() -> None:
    parquet_path = DB_FOLDER / "activities.parquet"
    if not parquet_path.exists():
        raise FileNotFoundError(f"Parquet file not found: {parquet_path}")
    if not JSON_FILE.exists():
        raise FileNotFoundError(f"JSON file not found: {JSON_FILE}")

    db = get_db_connection(SQL_FILE, read_only=True)
    parquet_con = duckdb.connect()

    db_count, db_max = db.execute("SELECT COUNT(*), MAX(start_date_local) FROM activities").fetchone()
    pq_count, pq_max = parquet_con.execute(
        f"SELECT COUNT(*), MAX(start_date_local) FROM read_parquet('{parquet_path}')"
    ).fetchone()

    activities = json.loads(Path(JSON_FILE).read_text())
    json_count = len(activities)
    json_max = max((item.get("start_date_local") for item in activities), default=None)
    if isinstance(json_max, str):
        json_max = json_max.replace("T", " ")

    errors: list[str] = []
    if db_count != pq_count or db_count != json_count:
        errors.append(f"count mismatch: db={db_count}, parquet={pq_count}, json={json_count}")
    if str(db_max) != str(pq_max) or str(db_max) != str(json_max):
        errors.append(f"max start_date_local mismatch: db={db_max}, parquet={pq_max}, json={json_max}")

    if errors:
        raise ValueError("Consistency check failed: " + "; ".join(errors))

    logger.info(f"Consistency check passed: count={db_count}, max_start_date_local={db_max}")


if __name__ == "__main__":
    from .cli.validate_data_consistency import main

    main()

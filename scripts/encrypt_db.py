import os
import shutil

import duckdb
from .config import SQL_FILE

from .utils import get_logger, load_env_config

logger = get_logger(__name__)


def encrypt_database():
    if not os.path.exists(SQL_FILE):
        logger.info(f"Database file {SQL_FILE} does not exist. No need to encrypt.")
        return

    env_config = load_env_config()
    key = env_config.get("duckdb_encryption_key")
    if not key:
        logger.error("No encryption key found in .env.local (DUCKDB_ENCRYPTION_KEY).")
        return

    # Check if already encrypted
    try:
        # Try to open without key
        con = duckdb.connect(SQL_FILE, read_only=True)
        # Try a simple query
        con.execute("SELECT 1")
        con.close()
        logger.info("Database is currently UNENCRYPTED. Proceeding with encryption...")
    except Exception:
        # If it fails, it might be encrypted or corrupt
        try:
            con = duckdb.connect()
            con.execute(f"ATTACH '{SQL_FILE}' AS test_db (TYPE DUCKDB, READ_ONLY TRUE, ENCRYPTION_KEY '{key}')")
            con.execute("SELECT 1")
            con.close()
            logger.info("Database is ALREADY ENCRYPTED with the provided key.")
            return
        except Exception as e:
            logger.error(f"Database seems encrypted but key didn't work, or other error: {e}")
            return

    # Create new encrypted DB
    new_db_path = SQL_FILE + ".new"
    if os.path.exists(new_db_path):
        os.remove(new_db_path)

    logger.info(f"Creating new encrypted database at {new_db_path}...")
    try:
        # Initialize new DB with key via ATTACH
        new_con = duckdb.connect()
        new_con.execute(f"ATTACH '{new_db_path}' AS new_db (TYPE DUCKDB, ENCRYPTION_KEY '{key}')")

        # Attach old DB (unencrypted)
        logger.info("Attaching old database...")
        new_con.execute(f"ATTACH '{SQL_FILE}' AS old_db")

        # Copy tables
        # Use simple query on sqlite_master if information_schema fails, but information_schema is better
        try:
            tables_df = new_con.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_catalog='old_db' AND table_schema='main'"
            ).fetchdf()
            tables = tables_df["table_name"].tolist()
        except Exception:
            # Fallback
            tables_df = new_con.execute("SELECT name FROM old_db.sqlite_master WHERE type='table'").fetchdf()
            tables = tables_df["name"].tolist()

        if not tables:
            logger.warning("No tables found in old database.")

        for table_name in tables:
            logger.info(f"Copying table {table_name}...")
            # Create table in new DB
            new_con.execute(f"CREATE TABLE new_db.{table_name} AS SELECT * FROM old_db.main.{table_name}")

        logger.info("Copy complete.")
        new_con.close()

        # Backup and Rename
        backup_path = SQL_FILE + ".bak"
        if os.path.exists(backup_path):
            os.remove(backup_path)

        shutil.move(SQL_FILE, backup_path)
        shutil.move(new_db_path, SQL_FILE)

        logger.info(f"Encryption successful! Original DB backed up to {backup_path}")

    except Exception as e:
        logger.error(f"Encryption failed: {e}")
        if os.path.exists(new_db_path):
            os.remove(new_db_path)


if __name__ == "__main__":
    encrypt_database()

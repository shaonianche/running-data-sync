import os

import duckdb
from config import DB_FOLDER, SQL_FILE

from utils import get_logger

logger = get_logger(__name__)

# List of tables to export to Parquet format.
# You can add any other table names here.
TABLES_TO_EXPORT = [
    "activities",
    "activities_flyby",
]

if not os.path.exists(DB_FOLDER):
    os.makedirs(DB_FOLDER)

# The SQL_FILE is now a duckdb file
with duckdb.connect(SQL_FILE, read_only=True) as conn:
    for table_name in TABLES_TO_EXPORT:
        try:
            parquet_path = os.path.join(DB_FOLDER, f"{table_name}.parquet")
            logger.info(f"Exporting table '{table_name}' to '{parquet_path}'...")
            conn.sql(f"COPY (SELECT * FROM {table_name}) TO '{parquet_path}' (FORMAT PARQUET);")
            logger.info(f"Successfully exported '{table_name}'.")
        except duckdb.CatalogException:
            logger.warning(f"Warning: Table '{table_name}' does not exist in the database. Skipping.")
        except Exception as e:
            logger.error(f"Error exporting table '{table_name}': {e}")

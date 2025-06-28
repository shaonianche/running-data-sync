import duckdb
from config import DB_FOLDER, SQL_FILE

# Connect directly to the DuckDB database file
with duckdb.connect(database=SQL_FILE, read_only=True) as conn:
    # Export the 'activities' table to a Parquet file
    conn.sql(
        f"COPY (SELECT * FROM activities) TO '{DB_FOLDER}/activities.parquet'"
        f" (FORMAT PARQUET, OVERWRITE_OR_IGNORE);"
    )

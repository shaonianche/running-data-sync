import duckdb
from config import DB_FOLDER, SQL_FILE

# The SQL_FILE is now a duckdb file
with duckdb.connect(SQL_FILE) as conn:
    conn.sql(
        f"COPY (SELECT * FROM activities) TO '{DB_FOLDER}/activities.parquet'"
        f" (FORMAT PARQUET);"
    )

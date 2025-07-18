import os

import duckdb
from config import DB_FOLDER, SQL_FILE

if not os.path.exists(DB_FOLDER):
    os.makedirs(DB_FOLDER)

# The SQL_FILE is now a duckdb file
with duckdb.connect(SQL_FILE) as conn:
    try:
        conn.sql(f"COPY (SELECT * FROM activities) TO '{DB_FOLDER}/activities.parquet' (FORMAT PARQUET);")
    except Exception as e:
        print(f"Error saving to parquet: {e}")
        # if there is no activities table, just ignore
        pass

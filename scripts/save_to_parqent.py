import duckdb
from config import DB_FOLDER, SQL_FILE

with duckdb.connect() as conn:
    conn.install_extension("sqlite")
    conn.load_extension("sqlite")
    conn.sql(f"ATTACH '{SQL_FILE}' (TYPE SQLITE);USE data;")
    conn.sql(
        f"COPY (SELECT * FROM activities) TO '{DB_FOLDER}/activities.parquet' (FORMAT PARQUET);"  # noqa: E501
    )

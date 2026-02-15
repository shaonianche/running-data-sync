## Running Data Sync & Visualization

This project syncs activity data from platforms like Strava and Garmin, stores it locally in DuckDB, and provides a web-based visualization dashboard.

### Features

- Sync Strava activities into DuckDB
- Export activities from DuckDB to FIT/TCX/GPX
- Sync DuckDB activities to Garmin / Garmin CN
- Reconcile Garmin remote data with local sync state
- Export DuckDB tables to Parquet for the frontend
- Visualize activities with maps and SVG posters

### Tech Stack

- Backend: Python 3.12+, PDM, DuckDB
- Frontend: React 19, Vite 7, TailwindCSS 4, DuckDB-WASM

### Setup

```bash
# Python dependencies
pdm install

# Frontend dependencies
pnpm install
```

### Environment Variables

Create `.env.local` at the project root:

```
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
STRAVA_REFRESH_TOKEN=
GARMIN_EMAIL=
GARMIN_PASSWORD=
GARMIN_SECRET=
GARMIN_SECRET_CN=
DUCKDB_ENCRYPTION_KEY=
```

### Common Commands

```bash
# Python lint
pdm run ruff check scripts/

# Python format
pdm run ruff format scripts/

# Frontend dev server
pnpm run develop

# Frontend build
pnpm run build

# Frontend lint
pnpm run lint
```

### CLI Usage (PDM Scripts)

Use the unified CLI from project root:

```bash
# Show all CLI help
pdm run strava-cli

# Sync Strava -> DuckDB
pdm run strava-cli sync db
pdm run strava-cli sync db --force
pdm run strava-cli sync db --prune

# Export from DuckDB (no Strava credentials required)
pdm run strava-cli export --format fit --id 123456
pdm run strava-cli export --format gpx --id-range 100000:100100
pdm run strava-cli export --format tcx --all

# Sync DuckDB -> Garmin/Garmin CN
pdm run strava-cli vendor garmin --secret-string <garmin_secret>
pdm run strava-cli vendor garmin --is-cn --secret-string <garmin_secret>
pdm run strava-cli vendor garmin --is-cn -f

# Reconcile local sync status with remote Garmin activities
pdm run strava-cli vendor garmin-reconcile --secret-string <garmin_secret>

# Vendor sync status / retry failed
pdm run strava-cli vendor status --vendor garmin --account garmin_com
pdm run strava-cli vendor status --retry-failed --is-cn

# Upload local .fit/.gpx/.tcx files directly to Garmin
pdm run strava-cli vendor garmin-files --secret-string <garmin_secret> data/FIT_OUT data/GPX_OUT

# Generate SVGs
pdm run gen_svg --from-db --type github --output public/assets/github.svg

# Export DuckDB tables to Parquet
pdm run save_to_parquet --tables activities activities_flyby

# Get Garmin secret string
pdm run get_garmin_secret <email> <password>
```

### Data Pipeline (High Level)

1. `strava-cli sync db` pulls Strava data into `data/data.duckdb` (`activities`, `activities_flyby`)
2. `strava-cli export` writes activity files under `data/FIT_OUT`, `data/GPX_OUT`, `data/TCX_OUT`
3. `strava-cli vendor garmin` uploads DuckDB activities and records sync state in `vendor_activity_sync`
4. `save_to_parquet` exports tables to `public/db/*.parquet` for frontend queries

### Acknowledgements

- Running page is based on [@flopp](https://github.com/flopp)'s [activities](https://github.com/flopp/activities) open source project.
- Original project inspiration from [@yihong0618](https://github.com/yihong0618/running_page).

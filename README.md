## Running Data Sync & Visualization

This project syncs activity data from platforms like Strava and Garmin, stores it locally in DuckDB, and provides a web-based visualization dashboard.

### Features

- Sync Strava activities
- Sync Garmin activities
- Generate FIT/TCX/GPX outputs
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

The CLI entrypoints live under `scripts/cli/`. Run them from the project root using PDM:

```bash
# Strava sync
pdm run strava_sync --client-id ... --client-secret ... --refresh-token ...

# Garmin sync
pdm run garmin_sync --is-cn

# Export a FIT file by activity ID
pdm run export_fit 123456 --output FIT_OUT/123456.fit

# Upload local FIT files to Garmin
pdm run fit_to_garmin_sync --is-cn

# Strava -> Garmin sync (API)
pdm run strava_to_garmin_sync --client-id ... --client-secret ... --refresh-token ...

# Strava web -> Garmin sync
pdm run stravaweb_to_garmin_sync --client-id ... --client-secret ... --refresh-token ... <secret> <jwt>

# Generate SVGs
pdm run gen_svg --from-db --type github --output public/assets/github.svg

# Sync GPX files
pdm run gpx_sync

# Export DuckDB tables to Parquet
pdm run save_to_parquet --tables activities activities_flyby

# Get Garmin secret string
pdm run get_garmin_secret <email> <password>
```

### Data Pipeline (High Level)

1. Sync activities into `scripts/data.duckdb`
2. Export tables to `public/db/*.parquet`
3. Frontend loads Parquet via DuckDB-WASM

### Acknowledgements

- Running page is based on [@flopp](https://github.com/flopp)'s [activities](https://github.com/flopp/activities) open source project.
- Original project inspiration from [@yihong0618](https://github.com/yihong0618/running_page).

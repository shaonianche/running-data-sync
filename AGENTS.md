# AGENTS.md

## Project Overview

This is a running/workout data synchronization and visualization project. It syncs activity data from platforms like Strava and Garmin, stores them locally, and provides a web-based visualization dashboard.

## Tech Stack

### Python (Backend/Scripts)
- **Python 3.12+** with PDM as package manager
- **DuckDB** for local database storage
- **Key libraries**: stravalib, garth (Garmin), gpxpy, fit-tool, pandas

### TypeScript/React (Frontend)
- **React 19** with TypeScript
- **Vite 7** as build tool
- **MapLibre GL** for map visualization
- **TailwindCSS 4** for styling
- **DuckDB-WASM** for client-side data queries

## Project Structure

```
scripts/           # Python scripts for data sync
  ├── generator/   # Database and FIT file generation
  ├── gpxtrackposter/  # GPX/TCX/FIT track processing and SVG generation
  ├── garmin_sync.py   # Garmin data sync
  ├── strava_sync.py   # Strava data sync
  └── config.py        # Path configurations
src/               # React frontend
  ├── components/  # React components
  ├── pages/       # Page components
  ├── hooks/       # Custom React hooks
  └── utils/       # Utility functions
public/            # Static assets and generated SVGs
GPX_OUT/           # Downloaded GPX files
FIT_OUT/           # Downloaded FIT files
activities/        # Processed activity data
```

## Commands

### Python

```bash
# Install dependencies
pdm install

# Lint Python code
pdm run ruff check scripts/

# Format Python code
pdm run ruff format scripts/

# Sync Garmin data
python scripts/garmin_sync.py

# Sync Strava data
python scripts/strava_sync.py

# Generate SVG visualizations
python scripts/gen_svg.py --from-db --type github --output public/assets/github.svg
```

### Frontend

```bash
# Install dependencies
pnpm install

# Development server
pnpm run develop

# Build for production
pnpm run build

# Lint TypeScript/React code
pnpm run lint

# Full CI check
pnpm run ci
```

## Code Style

### Python
- Line length: 120 characters
- Use double quotes for strings
- Follow PEP 8 with ruff enforcement
- Rules enabled: E (errors), F (pyflakes), I (isort), N (naming)

### TypeScript/React
- Use ESLint with @antfu/eslint-config
- Functional components with hooks
- TypeScript strict mode

## Configuration

Environment variables are loaded from `.env.local`:

```
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
STRAVA_REFRESH_TOKEN=
GARMIN_EMAIL=
GARMIN_PASSWORD=
GARMIN_SECRET=
GARMIN_SECRET_CN=
```

## Database

- Uses DuckDB stored at `scripts/data.duckdb`
- Main tables: `activities`, `activities_flyby`
- Exports to Parquet format in `public/db/` for frontend consumption

## Key Conventions

1. **Error handling**: Log errors with context, don't silently fail
2. **Async operations**: Use `asyncio` and `httpx` for HTTP calls in sync scripts
3. **Database writes**: Initialize DB connection lazily, only when writes are needed
4. **File paths**: Use `config.py` constants for all output directories
5. **Rate limiting**: Respect API rate limits for Strava (sleep between requests)

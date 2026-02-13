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
scripts/                     # Python scripts and modules
  ├── cli/                   # CLI entrypoints (used by pdm scripts)
  ├── generator/             # Database and FIT/TCX generation logic
  ├── gpxtrackposter/        # GPX/TCX/FIT track processing and SVG generation
  ├── config.py              # Shared path/constants configuration
  └── data.duckdb            # Local DuckDB database
src/                         # React frontend source
  ├── components/            # UI components
  ├── pages/                 # Route pages
  ├── hooks/                 # Custom hooks
  ├── utils/                 # Frontend utilities
  └── static/activities.json # Processed activity data JSON
public/                      # Static files served by Vite
  ├── assets/                # Generated SVG visualizations
  └── db/                    # Exported parquet files for frontend queries
tests/                       # Python unit tests
GPX_OUT/                     # Downloaded GPX files
FIT_OUT/                     # Downloaded FIT files
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
pdm run garmin_sync

# Sync Strava data
pdm run strava_sync

# Generate SVG visualizations
pdm run gen_svg --from-db --type github --output public/assets/github.svg
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

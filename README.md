## Running Data Sync & Visualization

A pure TypeScript pnpm monorepo that syncs running and workout data from Strava and Garmin into a local DuckDB database, exports FIT/TCX/GPX/JSON/Parquet/SVG artifacts, and serves an interactive visualization dashboard.

### Features

- Sync Strava activities and streams into local DuckDB (`data/data.duckdb`)
- Export activities from DuckDB to FIT, TCX, and GPX files
- Sync DuckDB activities to Garmin Connect (COM / CN) with idempotent matching
- Reconcile Garmin remote activities with local sync state (`vendor_activity_sync`)
- Download Garmin activities into DuckDB
- Export DuckDB tables to `activities.json` and Parquet files (`apps/web/public/db/*.parquet`) with 3-way consistency validation
- Render GitHub-style and Grid SVG posters (dark & light themes) directly from DuckDB or local track files
- Interactive React + MapLibre GL + DuckDB-WASM web dashboard (`apps/web`)

### Monorepo Structure

```text
apps/
  └── web/                  # React 19 + Vite 7 + TailwindCSS 4 + MapLibre GL + DuckDB-WASM dashboard
packages/
  ├── core/                 # @running-data-sync/core — reusable TypeScript sync, format, storage & SVG library
  └── cli/                  # @running-data-sync/cli  — unified CLI wrapper (`running-data-sync`)
data/
  └── data.duckdb           # Local unencrypted DuckDB database
```

### Tech Stack

- **Runtime & Package Manager**: Node.js >= 20, pnpm 10 workspace monorepo, TypeScript (strict mode)
- **Core & CLI (`packages/core`, `packages/cli`)**: `@duckdb/node-api`, `@garmin/fitsdk`, `@mapbox/polyline`, `fast-xml-parser`, `fflate`, Vitest
- **Web Dashboard (`apps/web`)**: React 19, Vite 7, TailwindCSS 4, MapLibre GL, Recharts, DuckDB-WASM

### Setup

```bash
# Install workspace dependencies
pnpm install

# Build core and CLI packages
pnpm run build:cli
```

### Environment Variables

Create `.env.local` at the repository root:

```env
STRAVA_CLIENT_ID=
STRAVA_CLIENT_SECRET=
STRAVA_REFRESH_TOKEN=
GARMIN_EMAIL=
GARMIN_PASSWORD=
GARMIN_IS_CN=
GARMIN_SECRET=
GARMIN_SECRET_CN=
```

### Development & CI Commands

```bash
# Start web dev server
pnpm run dev

# Build all workspace packages (core, cli, web)
pnpm run build

# Build web app only
pnpm run build:web

# Lint, typecheck, test, and build everything
pnpm run ci

# Individual checks
pnpm run lint
pnpm run typecheck
pnpm run test:run
```

### CLI Usage

Build the CLI once (`pnpm run build:cli`), then invoke it from the repository root via `pnpm run cli <command>` (or `node packages/cli/dist/cli.js <command>`):

```bash
# Show help and resolved paths
pnpm run cli --help
pnpm run cli --show-paths

# Sync Strava -> DuckDB
pnpm run cli sync db
pnpm run cli sync db --force
pnpm run cli sync db --prune
pnpm run cli sync db --only-run

# Export from DuckDB (no Strava credentials required)
pnpm run cli export --format fit --id 123456
pnpm run cli export --format gpx --id-range 100000:100100
pnpm run cli export --format tcx --all

# Sync DuckDB -> Garmin / Garmin CN
pnpm run cli vendor garmin --secret-string <garmin_secret>
pnpm run cli vendor garmin --is-cn --secret-string <garmin_secret>
pnpm run cli vendor garmin --is-cn -f

# Reconcile local sync status with remote Garmin activities
pnpm run cli vendor garmin-reconcile --secret-string <garmin_secret>

# Vendor sync status / retry failed
pnpm run cli vendor status --vendor garmin --account garmin_com
pnpm run cli vendor status --retry-failed --is-cn

# Upload local .fit/.gpx/.tcx files directly to Garmin
pnpm run cli vendor garmin-files --secret-string <garmin_secret> data/FIT_OUT data/GPX_OUT

# Download Garmin activities into DuckDB / fetch Garmin secret string
pnpm run cli garmin sync
pnpm run cli garmin secret <email> <password>

# Export JSON & Parquet and validate 3-way consistency
pnpm run cli data json
pnpm run cli data parquet --tables activities activities_flyby
pnpm run cli data validate

# Generate SVG posters
pnpm run cli svg --from-db --type github --output apps/web/public/assets/github.svg
pnpm run cli svg --from-db --type grid --min-distance 5 --output apps/web/public/assets/grid.svg
```

### Programmatic Core Library (`@running-data-sync/core`)

`@running-data-sync/core` exposes high-level facades and typed sub-APIs for reuse in scripts, services, or external tools:

```ts
import {
  exportActivitiesFromDb,
  exportActivitiesJson,
  exportParquet,
  generatePosterSvg,
  reconcileGarminDb,
  syncDbToGarmin,
  syncGarminToDb,
  syncStravaToDb,
  validateDataConsistency,
} from '@running-data-sync/core'
```

Browser-safe shared domain types are exported from `@running-data-sync/core/types` (zero Node.js runtime dependencies).

### Legacy `pdm run` to TypeScript CLI Quick Reference

| Legacy Python Command | TypeScript CLI Replacement |
| --- | --- |
| `pdm run strava-cli sync db` | `pnpm run cli sync db` |
| `pdm run strava-cli export --format fit --id <id>` | `pnpm run cli export --format fit --id <id>` |
| `pdm run strava-cli vendor garmin ...` | `pnpm run cli vendor garmin ...` |
| `pdm run strava-cli vendor garmin-reconcile ...` | `pnpm run cli vendor garmin-reconcile ...` |
| `pdm run strava-cli vendor status ...` | `pnpm run cli vendor status ...` |
| `pdm run strava-cli vendor garmin-files ...` | `pnpm run cli vendor garmin-files ...` |
| `pdm run garmin_sync` | `pnpm run cli garmin sync` |
| `pdm run get_garmin_secret <email> <password>` | `pnpm run cli garmin secret <email> <password>` |
| `pdm run export_fit <id> --output ...` | `pnpm run cli export --format fit --id <id>` |
| `pdm run save_to_parquet` | `pnpm run cli data parquet` |
| `pdm run validate_data_consistency` | `pnpm run cli data validate` |
| `pdm run gen_svg --from-db ...` | `pnpm run cli svg --from-db ...` (note: `--no-activity` replaces `--no-activity-color`; localtime is used by default) |

### Data Pipeline (High Level)

1. `pnpm run cli sync db` pulls Strava activities and streams into `data/data.duckdb` (`activities`, `activities_flyby`)
2. `pnpm run cli vendor garmin` exports/adapts FIT files in memory, uploads activities to Garmin COM / CN, and records sync state in `vendor_activity_sync`
3. `pnpm run cli data json` and `pnpm run cli data parquet` generate `apps/web/src/static/activities.json` and `apps/web/public/db/*.parquet`
4. `pnpm run cli data validate` verifies count and latest timestamp consistency across DuckDB, JSON, and Parquet
5. `pnpm run cli svg --from-db ...` regenerates the 4 dark/light SVG posters under `apps/web/public/assets/`

### Acknowledgements

- Running page is based on [@flopp](https://github.com/flopp)'s [activities](https://github.com/flopp/activities) open source project.
- Original project inspiration from [@yihong0618](https://github.com/yihong0618/running_page).

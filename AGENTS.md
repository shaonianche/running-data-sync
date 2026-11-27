# AGENTS.md

## Project Overview

This is a pure TypeScript pnpm monorepo for running/workout data synchronization and visualization. It syncs activity data from Strava and Garmin into a local unencrypted DuckDB database (`data/data.duckdb`), exports FIT/TCX/GPX/JSON/Parquet/SVG artifacts, and serves a React web dashboard.

## Tech Stack

- **Monorepo**: pnpm 10 workspaces (`apps/*`, `packages/*`), Node.js >= 20, TypeScript 5.8 (strict mode)
- **Core Library (`@running-data-sync/core`)**: `@duckdb/node-api` (1.4.4-r.4), `@garmin/fitsdk`, `@mapbox/polyline`, `@photostructure/tz-lookup`, `fast-xml-parser`, `fflate`
- **CLI (`@running-data-sync/cli`)**: Node.js `util.parseArgs` thin wrapper around `@running-data-sync/core`
- **Frontend (`apps/web`, workspace package `web`)**: React 19, Vite 7, TailwindCSS 4, MapLibre GL, Recharts, DuckDB-WASM
- **Testing & Linting**: Vitest 4, ESLint 9 (`@antfu/eslint-config`)

## Project Structure

```text
apps/
  └── web/                         # Workspace package `web` (React dashboard)
      ├── public/
      │   ├── assets/              # Generated SVG posters (github/grid dark & light)
      │   └── db/                  # Exported Parquet files for DuckDB-WASM queries
      └── src/
          ├── components/          # UI components
          ├── hooks/               # Custom hooks
          ├── pages/               # Route pages
          ├── static/
          │   └── activities.json  # Exported activity metadata JSON
          └── utils/               # Frontend utilities (retains historical location_country parsing)
packages/
  ├── core/                        # `@running-data-sync/core` reusable library
  │   └── src/
  │       ├── contracts/           # Shared domain types (`@running-data-sync/core/types` is browser-safe)
  │       ├── facade.ts            # High-level DB-backed orchestration facades
  │       ├── formats/             # GPX/TCX/FIT parser, encoder, Garmin device adaptor, batch exporter
  │       ├── foundation/          # Config, env loader, logger, error hierarchy
  │       ├── providers/
  │       │   ├── garmin/          # Garmin SSO/OAuth auth, client, upload, sync, reconcile
  │       │   └── strava/          # Strava OAuth/client, mapper, geocoding, sync
  │       ├── storage/             # DuckDB store, schema, polyline filter, JSON/Parquet export, 3-way validation
  │       ├── svg/                 # Pure TS GitHub & Grid SVG poster generator
  │       └── testing/             # Test fixtures & helpers (`@running-data-sync/core/testing`)
  └── cli/                         # `@running-data-sync/cli` (`running-data-sync` bin)
      └── src/
          ├── cli.ts               # Executable entrypoint (`dist/cli.js`)
          └── index.ts             # Command parser & dispatch
data/
  └── data.duckdb                  # Local unencrypted DuckDB database
.github/
  ├── dependabot.yml               # npm & github-actions dependency updates
  └── workflows/
      ├── frontend-ci.yml          # Monorepo CI (lint, typecheck, test, build)
      ├── gh-pages.yml             # GitHub Pages build & deploy (`apps/web/dist`)
      └── run-data-sync.yml        # Automated Strava/Garmin sync, export, validation & SVG generation
```

## Commands

### Workspace & Quality Checks

```bash
# Install dependencies
pnpm install

# Full CI check (lint + typecheck + test:run + build across core, cli, web)
pnpm run ci

# Individual checks
pnpm run lint
pnpm run lint:fix
pnpm run typecheck
pnpm run test
pnpm run test:run
pnpm run test:coverage
pnpm run build
pnpm run build:cli
pnpm run build:web

# Web development server
pnpm run dev
```

### CLI Commands

Build the CLI first (`pnpm run build:cli`), then invoke from the repository root with `pnpm run cli <command>` (or `node packages/cli/dist/cli.js <command>`):

```bash
# Inspect usage and resolved runtime paths
pnpm run cli --help
pnpm run cli --show-paths

# Sync Strava -> DuckDB
pnpm run cli sync db
pnpm run cli sync db --force
pnpm run cli sync db --prune
pnpm run cli sync db --only-run

# Export FIT / TCX / GPX from DuckDB
pnpm run cli export --format fit --id 123456
pnpm run cli export --format gpx --id-range 100000:100100
pnpm run cli export --format tcx --all

# Sync DuckDB -> Garmin / Garmin CN
pnpm run cli vendor garmin --secret-string <garmin_secret>
pnpm run cli vendor garmin --is-cn --secret-string <garmin_secret>
pnpm run cli vendor garmin-reconcile --secret-string <garmin_secret>
pnpm run cli vendor status --vendor garmin --account garmin_com
pnpm run cli vendor status --retry-failed --is-cn
pnpm run cli vendor garmin-files --secret-string <garmin_secret> data/FIT_OUT data/GPX_OUT

# Download Garmin activities / retrieve Garmin secret string
pnpm run cli garmin sync
pnpm run cli garmin secret <email> <password>

# Rebuild derived web data and verify 3-way consistency
pnpm run cli data json
pnpm run cli data parquet --tables activities activities_flyby
pnpm run cli data validate

# Generate SVG posters
pnpm run cli svg --from-db --type github --output apps/web/public/assets/github.svg
pnpm run cli svg --from-db --type grid --min-distance 5 --output apps/web/public/assets/grid.svg
```

### Legacy `pdm run` to TypeScript CLI Mapping

| Legacy Python Command | TypeScript CLI Command |
| --- | --- |
| `pdm run strava-cli sync db` | `pnpm run cli sync db` |
| `pdm run strava-cli export --format <fmt> ...` | `pnpm run cli export --format <fmt> ...` |
| `pdm run strava-cli vendor garmin ...` | `pnpm run cli vendor garmin ...` |
| `pdm run strava-cli vendor garmin-reconcile ...` | `pnpm run cli vendor garmin-reconcile ...` |
| `pdm run strava-cli vendor status ...` | `pnpm run cli vendor status ...` |
| `pdm run strava-cli vendor garmin-files ...` | `pnpm run cli vendor garmin-files ...` |
| `pdm run garmin_sync` | `pnpm run cli garmin sync` |
| `pdm run get_garmin_secret <email> <password>` | `pnpm run cli garmin secret <email> <password>` |
| `pdm run export_fit <id> ...` | `pnpm run cli export --format fit --id <id>` |
| `pdm run save_to_parquet` | `pnpm run cli data parquet` |
| `pdm run validate_data_consistency` | `pnpm run cli data validate` |
| `pdm run gen_svg --from-db ...` | `pnpm run cli svg --from-db ...` (`--no-activity` replaces `--no-activity-color`; localtime is always used) |

## Code Style

- ESLint with `@antfu/eslint-config` across `packages/*` and `apps/web`
- TypeScript strict mode (`tsconfig.base.json`)
- Functional React components with hooks in `apps/web`
- Keep `@running-data-sync/core/types` strictly type-only with zero Node.js runtime imports so `apps/web` bundles cleanly

## Configuration

Environment variables are loaded from `.env.local` (process environment overrides `.env.local`):

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

## Database

- Uses local unencrypted DuckDB stored at `data/data.duckdb`
- Main tables: `activities`, `activities_flyby`, `activities_flyby_queue`, `vendor_activity_sync`
- Exports `activities.json` to `apps/web/src/static/activities.json` and Parquet files (`activities.parquet`, `activities_flyby.parquet`) to `apps/web/public/db/`

## Key Conventions

1. **Error handling**: Use the typed error hierarchy in `packages/core/src/foundation/errors.ts`, redact sensitive values in logs, and do not silently swallow errors.
2. **Paths**: Resolve all repository and data paths via `resolveRuntimeConfig()` in `packages/core/src/foundation/config.ts` rather than hardcoding paths.
3. **CLI working directory**: Invoke `node packages/cli/dist/cli.js` (or `pnpm run cli ...`) from the repository root so relative `--output` / `--output-dir` paths resolve from the repo root.
4. **Deployment targets**: `apps/web` builds to `apps/web/dist` for Vercel (`vercel.json`), Cloudflare Workers (`wrangler.toml`), and GitHub Pages (`.github/workflows/gh-pages.yml` with `PATH_PREFIX=/$REPO_NAME`).
5. **Rate limiting**: Respect Strava and Garmin API rate limits in provider clients.

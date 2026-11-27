import { DB_COMMAND_HELP } from './db.js'

export function formatUsage(): string {
  return [
    'Usage: running-data-sync <command> [options]',
    '',
    'Commands:',
    '  sync db              Sync activities from Strava to DuckDB',
    '  vendor garmin        Sync DuckDB activities to Garmin (COM / CN)',
    '  vendor garmin-reconcile  Reconcile DuckDB activities with Garmin',
    '  vendor status        Show vendor sync status summary',
    '  vendor garmin-files  Upload local .fit/.gpx/.tcx files to Garmin',
    '  garmin sync          Download Garmin activities and ingest into DuckDB',
    '  garmin secret        Log in to Garmin and print a serialized secret string',
    '  export               Export FIT / TCX / GPX activity files from DuckDB',
    '  data json            Export activities.json from DuckDB',
    '  data parquet         Export Parquet tables from DuckDB',
    '  data validate        Validate 3-way consistency (DuckDB, JSON, Parquet)',
    '  db <subcommand>      Manage versioned DuckDB snapshots in private R2/S3',
    '  svg                  Generate GitHub / Grid SVG posters',
    '',
    'Options:',
    '  -h, --help           Show help information',
    '  -v, --version        Show CLI version',
    '  --show-paths         Print resolved runtime paths',
    '',
  ].join('\n')
}

export function formatSubcommandHelp(topic: string): string {
  switch (topic) {
    case 'sync':
      return [
        'Usage: running-data-sync sync db [options]',
        '',
        'Options:',
        '  --force                  Force full resync from Strava API',
        '  --prune                  Delete local activities absent from remote Strava',
        '  --only-run               Only sync running activities',
        '  --client-id <id>         Strava client ID override',
        '  --client-secret <secret> Strava client secret override',
        '  --refresh-token <token>  Strava refresh token override',
        '',
      ].join('\n')
    case 'vendor':
      return [
        'Usage: running-data-sync vendor <garmin|garmin-reconcile|status|garmin-files> [options]',
        '',
        'Subcommands:',
        '  garmin           Sync DuckDB activities to Garmin Connect',
        '  garmin-reconcile Match local activities against remote Garmin activities',
        '  status           Inspect vendor_activity_sync status or retry failed rows',
        '  garmin-files     Upload local .fit/.gpx/.tcx files or directories to Garmin',
        '',
      ].join('\n')
    case 'garmin':
      return [
        'Usage: running-data-sync garmin <sync|secret> [options]',
        '',
        'Subcommands:',
        '  sync [secret]    Download Garmin activities into local files & DuckDB',
        '  secret [email] [password]  Log in to Garmin and print secret string',
        '',
      ].join('\n')
    case 'export':
      return [
        'Usage: running-data-sync export --format <fit|tcx|gpx> (--all | --id <id> | --id-range <start:end>) [options]',
        '',
        'Options:',
        '  --format <fit|tcx|gpx>   Export format (required)',
        '  --all                    Export all activities in DuckDB',
        '  --id <id>                Export specific activity ID (repeatable)',
        '  --id-range <start:end>   Export inclusive activity ID range',
        '  --output-dir <dir>       Output directory override',
        '  --upload-private         Upload exported files to private R2/S3 object store',
        '',
      ].join('\n')
    case 'data':
      return [
        'Usage: running-data-sync data <json|parquet|validate> [options]',
        '',
        'Subcommands:',
        '  json             Export sanitized public activities.json from DuckDB',
        '  parquet          Export approved public DuckDB tables to Parquet files',
        '  validate         Validate 3-way consistency across DuckDB, JSON, and Parquet',
        '',
        'Parquet options:',
        '  --tables <list>  Comma-separated public tables (activities, activities_flyby)',
        '  --output-dir <d> Output directory override',
        '  --exclude-flyby  Omit activities_flyby.parquet from public export',
        '',
      ].join('\n')
    case 'db':
      return DB_COMMAND_HELP
    case 'svg':
      return [
        'Usage: running-data-sync svg [--from-db | --gpx-dir <dir>] --type <github|grid> --output <file> [options]',
        '',
        'Options:',
        '  --from-db                Read activities from DuckDB (default when --gpx-dir omitted)',
        '  --gpx-dir <dir>          Read .gpx/.tcx/.fit/.zip files from directory',
        '  --type <github|grid>     Poster drawer type (default: grid)',
        '  --output <file>          Output SVG path (default: poster.svg)',
        '  --year <year|all>        Year range filter (default: all)',
        '  --title <text>           Poster title',
        '  --athlete <name>         Athlete name',
        '  --language <lang>        Month label language (en/zh)',
        '  --background-color <hex> Background color',
        '  --track-color <hex>      Track color',
        '  --text-color <hex>       Text color',
        '  --special-color <hex>    Special distance color',
        '  --special-color2 <hex>   Special distance 2 color',
        '  --no-activity <hex>      Empty day cell color (github)',
        '  --special-distance <km>  Special distance threshold in km',
        '  --special-distance2 <km> Special distance 2 threshold in km',
        '  --min-distance <km>      Minimum distance filter in km',
        '  --only-run               Only include Run activities (--from-db)',
        '  --with-animation         Enable SVG animation',
        '',
      ].join('\n')
    default:
      return formatUsage()
  }
}

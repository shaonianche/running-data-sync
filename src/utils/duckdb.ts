import * as duckdb from '@duckdb/duckdb-wasm'

let duckdbInstance: duckdb.AsyncDuckDB | null = null
let duckdbConn: duckdb.AsyncDuckDBConnection | null = null

const JSDELIVR_BUNDLES = duckdb.getJsDelivrBundles()

export async function initDuckDB(): Promise<{
  db: duckdb.AsyncDuckDB
  conn: duckdb.AsyncDuckDBConnection
}> {
  if (duckdbInstance && duckdbConn) {
    return { db: duckdbInstance, conn: duckdbConn }
  }
  const bundle = await duckdb.selectBundle(JSDELIVR_BUNDLES)
  const worker_url = URL.createObjectURL(
    new Blob([`importScripts("${bundle.mainWorker!}");`], { type: 'text/javascript' }),
  )
  const worker = new Worker(worker_url)
  const logger = new duckdb.ConsoleLogger()
  duckdbInstance = new duckdb.AsyncDuckDB(logger, worker)
  await duckdbInstance.instantiate(bundle.mainModule, bundle.pthreadWorker)
  duckdbConn = await duckdbInstance.connect()
  URL.revokeObjectURL(worker_url)
  return { db: duckdbInstance, conn: duckdbConn }
}

export function getDuckDBConnection(): duckdb.AsyncDuckDBConnection | null {
  return duckdbConn
}

export async function loadDuckDBFile(
  db: duckdb.AsyncDuckDB,
  filePath: string = '/db/activities.parquet',
  dbName: string = 'activities.parquet',
) {
  const response = await fetch(filePath)
  if (!response.ok)
    throw new Error(`Failed to fetch duckdb file: ${filePath}`)
  const arrayBuffer = await response.arrayBuffer()
  await db.registerFileBuffer(dbName, new Uint8Array(arrayBuffer))
  const conn = await db.connect()
  return conn
}

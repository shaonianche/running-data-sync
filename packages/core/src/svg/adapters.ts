import type {
  ActivityFormatPort,
  ActivityQueryFilter,
  ActivityReadRepository,
  ParseableActivityFormat,
  ParsedTrack,
  PosterOptions,
  PosterTrack,
  SvgPosterGenerator,
} from '../contracts/index.js'
import type { Activity } from '../foundation/types.js'
import type { PolylinePrivacyOptions } from '../storage/polyline.js'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { filterPolyline } from '../storage/polyline.js'
import { ParameterError } from './errors.js'
import { renderPosterSvg } from './poster.js'
import { parseDatetimeToLocal } from './timezone.js'
import { parseLocalDateParts, parseLocalTimestampMs, YearRange } from './year-range.js'

const SUPPORTED_DIRECTORY_FORMATS: readonly ParseableActivityFormat[] = ['gpx', 'tcx', 'fit', 'zip']

export function activityToPosterTrack(
  activity: Activity,
  options: { readonly special?: boolean } = {},
): PosterTrack {
  return {
    runId: activity.run_id,
    name: activity.name,
    type: activity.type,
    startDateLocal: activity.start_date_local,
    distance: activity.distance,
    summaryPolyline: activity.summary_polyline ?? null,
    special: options.special ?? false,
  }
}

export function parsedTrackToPosterTrack(
  track: ParsedTrack,
  options: { readonly special?: boolean, readonly useLocalTime?: boolean } = {},
): PosterTrack {
  let startDateLocal = track.startDateLocal
  if (options.useLocalTime && (!startDateLocal || startDateLocal.endsWith('Z'))) {
    const startPoint = track.startLatLng ?? track.polylines[0]?.[0] ?? null
    startDateLocal = parseDatetimeToLocal(track.startDate, track.endDate, startPoint).startDateLocal
  }

  return {
    runId: track.runId,
    name: track.name,
    type: track.type,
    startDateLocal,
    distance: track.distance,
    summaryPolyline: track.summaryPolyline,
    polylines: track.polylines,
    special: options.special ?? false,
  }
}

function isTruthyEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false
  }
  const normalized = value.trim().toLowerCase()
  return normalized !== '' && normalized !== '0' && normalized !== 'false' && normalized !== 'no'
}

export interface LoadPosterTracksFromRepositoryOptions {
  readonly onlyRun?: boolean
  readonly types?: readonly string[]
  readonly minDistanceKm?: number
  readonly hasPolyline?: boolean
  readonly year?: string
  readonly specialRunIds?: ReadonlySet<number> | readonly number[]
  /**
   * Whether to apply privacy polyline filtering (`filterPolyline`) to `summaryPolyline`.
   * Defaults to `true` unless `IGNORE_BEFORE_SAVING` is truthy in env.
   */
  readonly applyPolylineFilter?: boolean
  /** Privacy polyline filtering options. */
  readonly polylineOptions?: PolylinePrivacyOptions
}

/**
 * Load poster tracks from any injected `ActivityReadRepository` (`fromDb` mode)
 * with zero direct database dependencies.
 */
export async function loadPosterTracksFromRepository(
  repository: ActivityReadRepository,
  options: LoadPosterTracksFromRepositoryOptions = {},
): Promise<PosterTrack[]> {
  const yearRange = new YearRange()
  const yearOption = options.year ?? 'all'
  if (!yearRange.parse(yearOption)) {
    throw new ParameterError(`Bad year range: ${yearOption}.`)
  }

  const filter: ActivityQueryFilter = {
    ...(options.types !== undefined
      ? { types: options.types }
      : { onlyRun: options.onlyRun ?? true }),
    ...(options.minDistanceKm !== undefined ? { minDistance: options.minDistanceKm * 1000 } : {}),
    ...(options.hasPolyline ? { hasPolyline: true } : {}),
    ...(yearRange.fromYear !== null ? { startDateLocalFrom: `${yearRange.fromYear}-01-01` } : {}),
    ...(yearRange.toYear !== null ? { startDateLocalTo: `${yearRange.toYear}-12-31T23:59:59.999` } : {}),
  }

  const activities = await repository.listActivities(filter)
  const specialSet = options.specialRunIds
    ? (options.specialRunIds instanceof Set ? options.specialRunIds : new Set(options.specialRunIds))
    : null

  const env = options.polylineOptions?.env ?? process.env
  const shouldFilterPolyline = options.applyPolylineFilter ?? !isTruthyEnvFlag(env.IGNORE_BEFORE_SAVING)

  const tracks: PosterTrack[] = []
  for (const activity of activities) {
    if (!yearRange.containsDate(activity.start_date_local)) {
      continue
    }
    const rawPolyline = activity.summary_polyline ?? null
    const summaryPolyline = shouldFilterPolyline
      ? filterPolyline(rawPolyline, options.polylineOptions)
      : rawPolyline
    tracks.push(
      activityToPosterTrack(
        { ...activity, summary_polyline: summaryPolyline },
        {
          special: specialSet ? specialSet.has(activity.run_id) : false,
        },
      ),
    )
  }

  return tracks
}

export interface RenderPosterFromRepositoryOptions
  extends PosterOptions,
  Omit<LoadPosterTracksFromRepositoryOptions, 'minDistanceKm' | 'year'> {}

export async function renderPosterFromRepository(
  repository: ActivityReadRepository,
  options: RenderPosterFromRepositoryOptions,
  generator?: SvgPosterGenerator,
): Promise<string> {
  const tracks = await loadPosterTracksFromRepository(repository, {
    onlyRun: options.onlyRun,
    types: options.types,
    minDistanceKm: options.minDistanceKm,
    hasPolyline: options.hasPolyline,
    year: options.year,
    specialRunIds: options.specialRunIds,
    applyPolylineFilter: options.applyPolylineFilter,
    polylineOptions: options.polylineOptions,
  })
  return renderPosterSvg(tracks, options, generator)
}

export interface TrackFileInput {
  readonly fileName: string
  readonly data: Uint8Array | string
  readonly format?: ParseableActivityFormat
}

export interface LoadPosterTracksFromFilesOptions {
  readonly year?: string
  readonly minDistanceKm?: number
  readonly specialFileNames?: ReadonlySet<string> | readonly string[]
  readonly mergeWithinSeconds?: number
  readonly useLocalTime?: boolean
  readonly onParseError?: (fileName: string, error: unknown) => void
}

interface MergeableParsedTrack {
  track: ParsedTrack
  special: boolean
  startMs: number
  endMs: number
}

function detectFormatFromFileName(fileName: string): ParseableActivityFormat | undefined {
  const ext = path.extname(fileName).toLowerCase().slice(1)
  if (ext === 'gpx' || ext === 'tcx' || ext === 'fit' || ext === 'zip') {
    return ext
  }
  return undefined
}

function mergeParsedTracks(
  items: MergeableParsedTrack[],
  mergeWithinSeconds: number,
): MergeableParsedTrack[] {
  if (items.length <= 1 || mergeWithinSeconds <= 0) {
    return items
  }

  const sorted = [...items].sort((a, b) => a.startMs - b.startMs)
  const merged: MergeableParsedTrack[] = []

  for (const current of sorted) {
    const previous = merged.at(-1)
    if (!previous) {
      merged.push(current)
      continue
    }

    const gapSeconds = (current.startMs - previous.endMs) / 1000
    if (gapSeconds > 0 && gapSeconds < mergeWithinSeconds && previous.track.type === current.track.type) {
      previous.track = {
        ...previous.track,
        endDate: current.track.endDate,
        endDateLocal: current.track.endDateLocal,
        distance: previous.track.distance + current.track.distance,
        movingTime: previous.track.movingTime + current.track.movingTime,
        elapsedTime: previous.track.elapsedTime + current.track.elapsedTime,
        polylines: [...previous.track.polylines, ...current.track.polylines],
        points: [...previous.track.points, ...current.track.points],
      }
      previous.special = previous.special || current.special
      previous.endMs = Math.max(previous.endMs, current.endMs)
    }
    else {
      merged.push(current)
    }
  }

  return merged
}

/**
 * Parse and filter in-memory track files via an injected `ActivityFormatPort`.
 */
export async function loadPosterTracksFromFiles(
  files: readonly TrackFileInput[],
  formatPort: ActivityFormatPort,
  options: LoadPosterTracksFromFilesOptions = {},
): Promise<PosterTrack[]> {
  const yearRange = new YearRange()
  const yearOption = options.year ?? 'all'
  if (!yearRange.parse(yearOption)) {
    throw new ParameterError(`Bad year range: ${yearOption}.`)
  }

  const specialSet = options.specialFileNames
    ? (options.specialFileNames instanceof Set ? options.specialFileNames : new Set(options.specialFileNames))
    : null
  const mergeWithinSeconds = options.mergeWithinSeconds ?? 3600
  const minDistanceMeters = options.minDistanceKm !== undefined ? options.minDistanceKm * 1000 : 100

  const parsedItems: MergeableParsedTrack[] = []

  for (const file of files) {
    const baseName = path.basename(file.fileName)
    const format = file.format ?? detectFormatFromFileName(baseName)
    try {
      const parsed = await formatPort.parseTrack(file.data, {
        fileName: baseName,
        ...(format ? { format } : {}),
      })

      if (Math.trunc(parsed.distance) <= 0) {
        continue
      }

      let startDateLocal = parsed.startDateLocal
      let endDateLocal = parsed.endDateLocal
      if (options.useLocalTime && (!startDateLocal || startDateLocal.endsWith('Z'))) {
        const startPoint = parsed.startLatLng ?? parsed.polylines[0]?.[0] ?? null
        const converted = parseDatetimeToLocal(parsed.startDate, parsed.endDate, startPoint)
        startDateLocal = converted.startDateLocal
        endDateLocal = converted.endDateLocal ?? endDateLocal
      }

      const parts = parseLocalDateParts(startDateLocal)
      if (!parts || !yearRange.containsYear(parts.year)) {
        continue
      }

      const startMs = parseLocalTimestampMs(startDateLocal) ?? 0
      const endMs = parseLocalTimestampMs(endDateLocal) ?? startMs

      parsedItems.push({
        track: {
          ...parsed,
          startDateLocal,
          endDateLocal,
        },
        special: specialSet ? specialSet.has(baseName) : false,
        startMs,
        endMs,
      })
    }
    catch (error) {
      options.onParseError?.(file.fileName, error)
    }
  }

  const merged = mergeParsedTracks(parsedItems, mergeWithinSeconds)

  return merged
    .filter(item => item.track.distance >= minDistanceMeters)
    .map(item => parsedTrackToPosterTrack(item.track, { special: item.special }))
}

export interface LoadPosterTracksFromDirectoryOptions extends LoadPosterTracksFromFilesOptions {
  readonly formats?: readonly ParseableActivityFormat[]
  readonly skipFileNames?: ReadonlySet<string> | readonly string[]
}

/**
 * Load poster tracks from a local directory via an injected `ActivityFormatPort`
 * with zero direct parser/FIT SDK imports.
 */
export async function loadPosterTracksFromDirectory(
  dirPath: string,
  formatPort: ActivityFormatPort,
  options: LoadPosterTracksFromDirectoryOptions = {},
): Promise<PosterTrack[]> {
  let dirStats
  try {
    dirStats = await stat(dirPath)
  }
  catch {
    throw new ParameterError(`Not a directory: ${dirPath}`)
  }
  if (!dirStats.isDirectory()) {
    throw new ParameterError(`Not a directory: ${dirPath}`)
  }

  const allowedFormats = new Set<string>(options.formats ?? SUPPORTED_DIRECTORY_FORMATS)
  const skipSet = options.skipFileNames
    ? (options.skipFileNames instanceof Set ? options.skipFileNames : new Set(options.skipFileNames))
    : null

  const entries = (await readdir(dirPath, { withFileTypes: true }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const files: TrackFileInput[] = []

  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) {
      continue
    }
    if (skipSet?.has(entry.name)) {
      continue
    }
    const format = detectFormatFromFileName(entry.name)
    if (!format || !allowedFormats.has(format)) {
      continue
    }

    const fullPath = path.join(dirPath, entry.name)
    const buffer = await readFile(fullPath)
    if (buffer.byteLength === 0) {
      continue
    }

    files.push({
      fileName: entry.name,
      data: format === 'gpx' || format === 'tcx'
        ? buffer.toString('utf8')
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
      format,
    })
  }

  return loadPosterTracksFromFiles(files, formatPort, options)
}

export interface RenderPosterFromDirectoryOptions
  extends PosterOptions,
  Omit<LoadPosterTracksFromDirectoryOptions, 'minDistanceKm' | 'year'> {}

export async function renderPosterFromDirectory(
  dirPath: string,
  formatPort: ActivityFormatPort,
  options: RenderPosterFromDirectoryOptions,
  generator?: SvgPosterGenerator,
): Promise<string> {
  const tracks = await loadPosterTracksFromDirectory(dirPath, formatPort, {
    formats: options.formats,
    skipFileNames: options.skipFileNames,
    year: options.year,
    minDistanceKm: options.minDistanceKm,
    specialFileNames: options.specialFileNames,
    mergeWithinSeconds: options.mergeWithinSeconds,
    useLocalTime: options.useLocalTime,
    onParseError: options.onParseError,
  })
  return renderPosterSvg(tracks, options, generator)
}

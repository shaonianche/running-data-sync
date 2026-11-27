import type {
  GithubPosterStyle,
  PosterDrawer,
  PosterOptions,
  PosterPoint,
  PosterRenderContext,
  PosterSpecialDistance,
  PosterTheme,
  PosterTrack,
  PosterType,
  PosterUnits,
  SvgPosterGenerator,
} from '../contracts/svg.js'
import { createGithubDrawer, resolveMonthNames } from './drawers/github-drawer.js'
import { createGridDrawer } from './drawers/grid-drawer.js'
import { ParameterError, PosterError } from './errors.js'
import { formatDistance, formatFloat, unitLabel } from './formatting.js'
import { svgDocument, svgRect, svgText } from './svg-builder.js'
import { ValueRange } from './value-range.js'
import { getIsoWeekNumber, parseLocalDateParts, YearRange } from './year-range.js'

export const DEFAULT_POSTER_WIDTH = 200
export const DEFAULT_POSTER_HEIGHT = 300
export const DEFAULT_POSTER_TITLE = 'MY TRACKS'
export const DEFAULT_POSTER_ATHLETE = 'John Doe'

export const DEFAULT_SPECIAL_DISTANCE: PosterSpecialDistance = {
  specialDistance: 10,
  specialDistance2: 20,
}

export const DEFAULT_POSTER_THEME: PosterTheme = {
  background: '#222222',
  text: '#FFFFFF',
  track: '#4DD2FF',
  track2: '#4DD2FF',
  special: '#FFFF00',
  special2: '#FFFF00',
  noActivity: '#444444',
}

/**
 * Production dark theme used by `.github/workflows/run-data-sync.yml` (`github.svg`, `grid.svg`).
 */
export const DARK_POSTER_THEME: PosterTheme = {
  background: '#222222',
  text: '#FFFFFF',
  track: '#4DD2FF',
  track2: '#4DD2FF',
  special: 'yellow',
  special2: 'red',
  noActivity: '#444444',
}

/**
 * Production light theme used by `.github/workflows/run-data-sync.yml` (`github-light.svg`, `grid-light.svg`).
 */
export const LIGHT_POSTER_THEME: PosterTheme = {
  background: '#e5e5e5',
  text: '#262626',
  track: '#525252',
  track2: '#525252',
  special: '#024a70',
  special2: '#ff8904',
  noActivity: '#d4d4d4',
}

function resolveTheme(partial?: Partial<PosterTheme>): PosterTheme {
  const track = partial?.track ?? DEFAULT_POSTER_THEME.track
  const special = partial?.special ?? DEFAULT_POSTER_THEME.special
  return {
    background: partial?.background ?? DEFAULT_POSTER_THEME.background,
    text: partial?.text ?? DEFAULT_POSTER_THEME.text,
    track,
    track2: partial?.track2 ?? track,
    special,
    special2: partial?.special2 ?? special,
    noActivity: partial?.noActivity ?? DEFAULT_POSTER_THEME.noActivity,
  }
}

function resolveSpecialDistance(partial?: Partial<PosterSpecialDistance>): PosterSpecialDistance {
  return {
    specialDistance: partial?.specialDistance ?? DEFAULT_SPECIAL_DISTANCE.specialDistance,
    specialDistance2: partial?.specialDistance2 ?? DEFAULT_SPECIAL_DISTANCE.specialDistance2,
  }
}

interface PosterStatistics {
  readonly totalLength: number
  readonly averageLength: number
  readonly minLength: number
  readonly maxLength: number
  readonly weeks: number
}

function computeTrackStatistics(tracks: readonly PosterTrack[]): PosterStatistics {
  const lengthRange = new ValueRange()
  let totalLength = 0
  const weekSet = new Set<string>()

  for (const track of tracks) {
    totalLength += track.distance
    lengthRange.extend(track.distance)
    const parts = parseLocalDateParts(track.startDateLocal)
    if (parts) {
      weekSet.add(`${parts.year}-${getIsoWeekNumber(parts.year, parts.month, parts.day)}`)
    }
  }

  return {
    totalLength,
    averageLength: totalLength / tracks.length,
    minLength: lengthRange.lower,
    maxLength: lengthRange.upper,
    weeks: Math.max(1, weekSet.size),
  }
}

function drawHeader(context: PosterRenderContext): string {
  return svgText({
    x: 10,
    y: 20,
    text: context.title,
    fill: context.theme.text,
    style: 'font-size:12px; font-family:Arial; font-weight:bold;',
  })
}

function drawFooter(context: PosterRenderContext): string {
  const textColor = context.theme.text
  const headerStyle = 'font-size:4px; font-family:Arial'
  const valueStyle = 'font-size:9px; font-family:Arial'
  const smallValueStyle = 'font-size:3px; font-family:Arial'
  const unit = unitLabel(context.units)
  const stats = computeTrackStatistics(context.tracks)
  const height = context.height

  return [
    svgText({ x: 10, y: height - 20, text: 'Runner', fill: textColor, style: headerStyle }),
    svgText({ x: 10, y: height - 10, text: context.athlete, fill: textColor, style: valueStyle }),
    svgText({ x: 65, y: height - 20, text: 'SPECIAL TRACKS', fill: textColor, style: headerStyle }),
    svgRect({ x: 65, y: height - 17, width: 2.6, height: 2.6, fill: context.theme.special }),
    svgText({
      x: 70,
      y: height - 14.5,
      text: `Over ${formatFloat(context.specialDistance.specialDistance)} ${unit}`,
      fill: textColor,
      style: smallValueStyle,
    }),
    svgRect({
      x: 65,
      y: height - 13,
      width: 2.6,
      height: 2.6,
      fill: context.theme.special2 ?? context.theme.special,
    }),
    svgText({
      x: 70,
      y: height - 10.5,
      text: `Over ${formatFloat(context.specialDistance.specialDistance2)} ${unit}`,
      fill: textColor,
      style: smallValueStyle,
    }),
    svgText({ x: 120, y: height - 20, text: 'STATISTICS', fill: textColor, style: headerStyle }),
    svgText({ x: 120, y: height - 15, text: `Number: ${context.tracks.length}`, fill: textColor, style: smallValueStyle }),
    svgText({
      x: 120,
      y: height - 10,
      text: `Weekly: ${formatFloat(context.tracks.length / stats.weeks)}`,
      fill: textColor,
      style: smallValueStyle,
    }),
    svgText({
      x: 141,
      y: height - 15,
      text: `Total: ${formatDistance(stats.totalLength, context.units)}`,
      fill: textColor,
      style: smallValueStyle,
    }),
    svgText({
      x: 141,
      y: height - 10,
      text: `Avg: ${formatDistance(stats.averageLength, context.units)}`,
      fill: textColor,
      style: smallValueStyle,
    }),
    svgText({
      x: 167,
      y: height - 15,
      text: `Min: ${formatDistance(stats.minLength, context.units)}`,
      fill: textColor,
      style: smallValueStyle,
    }),
    svgText({
      x: 167,
      y: height - 10,
      text: `Max: ${formatDistance(stats.maxLength, context.units)}`,
      fill: textColor,
      style: smallValueStyle,
    }),
  ].join('')
}

function buildRenderContext(
  tracks: readonly PosterTrack[],
  options: PosterOptions,
): PosterRenderContext {
  const yearFilter = new YearRange()
  const yearOption = options.year ?? 'all'
  if (!yearFilter.parse(yearOption)) {
    throw new ParameterError(`Bad year range: ${yearOption}.`)
  }

  const minDistanceMeters = options.minDistanceKm !== undefined ? options.minDistanceKm * 1000 : null
  const filteredTracks: PosterTrack[] = []
  const dataYears = new YearRange()

  for (const track of tracks) {
    if (minDistanceMeters !== null && track.distance < minDistanceMeters) {
      continue
    }
    const parts = parseLocalDateParts(track.startDateLocal)
    if (!parts) {
      continue
    }
    if (!yearFilter.containsYear(parts.year)) {
      continue
    }
    filteredTracks.push(track)
    dataYears.addYear(parts.year)
  }

  if (filteredTracks.length === 0) {
    throw new PosterError('No tracks to draw.')
  }

  const tracksByDate: Record<string, PosterTrack[]> = {}
  const totalDistanceByYear: Record<number, number> = {}
  let totalDistance = 0

  for (const track of filteredTracks) {
    const parts = parseLocalDateParts(track.startDateLocal)!
    if (!tracksByDate[parts.dateKey]) {
      tracksByDate[parts.dateKey] = []
    }
    tracksByDate[parts.dateKey].push(track)
    totalDistanceByYear[parts.year] = (totalDistanceByYear[parts.year] ?? 0) + track.distance
    totalDistance += track.distance
  }

  const units: PosterUnits = options.units ?? 'metric'
  const githubStyle: GithubPosterStyle = options.githubStyle ?? 'align-firstday'
  const theme = resolveTheme(options.theme)
  const specialDistance = resolveSpecialDistance(options.specialDistance)

  return {
    tracks: filteredTracks,
    tracksByDate,
    years: dataYears.all(),
    totalDistanceByYear,
    totalDistance,
    units,
    theme,
    specialDistance,
    githubStyle,
    title: options.title ?? DEFAULT_POSTER_TITLE,
    athlete: options.athlete ?? DEFAULT_POSTER_ATHLETE,
    width: options.width ?? DEFAULT_POSTER_WIDTH,
    height: options.height ?? DEFAULT_POSTER_HEIGHT,
  }
}

/**
 * Pure in-memory SVG poster generator implementing `SvgPosterGenerator` with an
 * extensible `PosterDrawer` registry (pre-populated with `github` and `grid`).
 */
export class PosterGenerator implements SvgPosterGenerator {
  private readonly drawers = new Map<PosterType, PosterDrawer>()
  private readonly defaultGithubDrawer: PosterDrawer

  constructor(drawers?: readonly PosterDrawer[]) {
    this.defaultGithubDrawer = createGithubDrawer()
    this.registerDrawer(this.defaultGithubDrawer)
    this.registerDrawer(createGridDrawer())
    if (drawers) {
      for (const drawer of drawers) {
        this.registerDrawer(drawer)
      }
    }
  }

  get supportedTypes(): readonly PosterType[] {
    return [...this.drawers.keys()]
  }

  registerDrawer(drawer: PosterDrawer): void {
    this.drawers.set(drawer.type, drawer)
  }

  render(tracks: readonly PosterTrack[], options: PosterOptions): string {
    const registeredDrawer = this.drawers.get(options.type)
    if (!registeredDrawer) {
      const supported = this.supportedTypes.join(', ')
      throw new ParameterError(`Unknown poster type "${options.type}". Supported types: ${supported}.`)
    }

    const activeDrawer = options.type === 'github' && options.language && registeredDrawer === this.defaultGithubDrawer
      ? createGithubDrawer({ monthNames: resolveMonthNames(options.language) })
      : registeredDrawer

    const initialContext = buildRenderContext(tracks, options)
    const computedDimensions = activeDrawer.computeDimensions?.(initialContext)

    const width = options.width ?? computedDimensions?.width ?? initialContext.width
    const height = options.height ?? computedDimensions?.height ?? initialContext.height

    const context: PosterRenderContext = (width === initialContext.width && height === initialContext.height)
      ? initialContext
      : { ...initialContext, width, height }

    const drawSize: PosterPoint = {
      x: width - 20,
      y: height - 60,
    }
    const drawOffset: PosterPoint = {
      x: 10,
      y: 30,
    }

    const body = [
      svgRect({ x: 0, y: 0, width, height, fill: context.theme.background }),
      drawHeader(context),
      drawFooter(context),
      activeDrawer.draw(context, drawSize, drawOffset),
    ].join('')

    return svgDocument({ width, height, body })
  }
}

export function createSvgPosterGenerator(extraDrawers?: readonly PosterDrawer[]): SvgPosterGenerator {
  return new PosterGenerator(extraDrawers)
}

const defaultPosterGenerator: SvgPosterGenerator = createSvgPosterGenerator()

/**
 * Pure in-memory SVG poster rendering entrypoint.
 */
export function renderPosterSvg(
  tracks: readonly PosterTrack[],
  options: PosterOptions,
  generator: SvgPosterGenerator = defaultPosterGenerator,
): string {
  return generator.render(tracks, options)
}

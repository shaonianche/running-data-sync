export type PosterUnits = 'metric' | 'imperial'

export type GithubPosterStyle = 'align-firstday' | 'align-monday'

/**
 * Built-in SVG poster drawer types, open to custom drawer registrations.
 */
export type PosterType = 'github' | 'grid' | (string & {})

export interface PosterPoint {
  readonly x: number
  readonly y: number
}

export interface PosterDimensions {
  readonly width: number
  readonly height: number
}

/**
 * Minimal track projection consumed by SVG poster renderers.
 */
export interface PosterTrack {
  readonly runId: number
  readonly name?: string
  readonly type: string
  readonly startDateLocal: string
  readonly distance: number
  readonly summaryPolyline?: string | null
  readonly polylines?: readonly (readonly (readonly [number, number])[])[]
  readonly special?: boolean
}

/**
 * Color palette applied when rendering an SVG poster.
 */
export interface PosterTheme {
  readonly background: string
  readonly text: string
  readonly track: string
  readonly track2?: string
  readonly special: string
  readonly special2?: string
  readonly noActivity?: string
}

/**
 * Distance thresholds (in km) for highlighting special runs on posters.
 */
export interface PosterSpecialDistance {
  readonly specialDistance: number
  readonly specialDistance2: number
}

/**
 * User-supplied rendering options for `SvgPosterGenerator.render`.
 */
export interface PosterOptions {
  readonly type: PosterType
  readonly title?: string
  readonly athlete?: string
  readonly year?: string
  readonly language?: string
  readonly units?: PosterUnits
  readonly theme?: Partial<PosterTheme>
  readonly specialDistance?: Partial<PosterSpecialDistance>
  readonly minDistanceKm?: number
  readonly githubStyle?: GithubPosterStyle
  readonly width?: number
  readonly height?: number
}

/**
 * Resolved rendering context passed to a `PosterDrawer`.
 */
export interface PosterRenderContext {
  readonly tracks: readonly PosterTrack[]
  readonly tracksByDate: Readonly<Record<string, readonly PosterTrack[]>>
  readonly years: readonly number[]
  readonly totalDistanceByYear: Readonly<Record<number, number>>
  readonly totalDistance: number
  readonly units: PosterUnits
  readonly theme: PosterTheme
  readonly specialDistance: PosterSpecialDistance
  readonly githubStyle: GithubPosterStyle
  readonly title: string
  readonly athlete: string
  readonly width: number
  readonly height: number
}

/**
 * Extensible poster drawer plugin contract (implemented by `github`, `grid`, and custom drawers).
 */
export interface PosterDrawer {
  readonly type: PosterType
  /** Optional hook to override canvas dimensions based on track data (e.g. multi-year `github` height). */
  computeDimensions?: (context: PosterRenderContext) => PosterDimensions
  /** Render the SVG body elements for this drawer inside the given viewport box. */
  draw: (context: PosterRenderContext, size: PosterPoint, offset: PosterPoint) => string
}

/**
 * Pure in-memory SVG poster generator port.
 */
export interface SvgPosterGenerator {
  readonly supportedTypes: readonly PosterType[]
  registerDrawer: (drawer: PosterDrawer) => void
  render: (tracks: readonly PosterTrack[], options: PosterOptions) => string
}

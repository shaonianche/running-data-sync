import type { PosterPoint } from '../contracts/svg.js'

export type LatLngTuple = readonly [number, number]

export const DEFAULT_ZOOM_THRESHOLD = 400

const MAX_MERCATOR_LAT = 89.9999

function normalizeLat(lat: number): number {
  return Math.max(-90, Math.min(90, lat))
}

function normalizeLng(lng: number): number {
  if (lng >= -180 && lng <= 180) {
    return lng
  }
  let normalized = ((lng + 180) % 360 + 360) % 360 - 180
  if (normalized === -180 && lng > 0) {
    normalized = 180
  }
  return normalized
}

function positiveDistanceDeg(a: number, b: number): number {
  const diff = b - a
  return diff >= 0 ? diff : diff + 360
}

/**
 * Decode a Google Encoded Polyline string (1e5 precision) into `[lat, lng]` coordinate pairs.
 */
export function decodePolyline(encoded: string | null | undefined): LatLngTuple[] {
  if (!encoded) {
    return []
  }

  const coordinates: LatLngTuple[] = []
  let index = 0
  let lat = 0
  let lng = 0
  const length = encoded.length

  while (index < length) {
    let shift = 0
    let result = 0
    let byte = 0
    do {
      if (index >= length) {
        return coordinates
      }
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1F) << shift
      shift += 5
    } while (byte >= 0x20)
    const dLat = (result & 1) !== 0 ? ~(result >> 1) : (result >> 1)
    lat += dLat

    shift = 0
    result = 0
    do {
      if (index >= length) {
        return coordinates
      }
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1F) << shift
      shift += 5
    } while (byte >= 0x20)
    const dLng = (result & 1) !== 0 ? ~(result >> 1) : (result >> 1)
    lng += dLng

    coordinates.push([lat / 1e5, lng / 1e5])
  }

  return coordinates
}

/**
 * Geographic bounding box matching S2 `LatLngRect` semantics (with shortest-arc longitude interval).
 */
export class LatLngBounds {
  private _latLo: number | null = null
  private _latHi: number | null = null
  private _lngLo: number | null = null
  private _lngHi: number | null = null

  isValid(): boolean {
    return this._latLo !== null
      && this._latHi !== null
      && this._lngLo !== null
      && this._lngHi !== null
  }

  get latLo(): number {
    if (this._latLo === null) {
      throw new Error('LatLngBounds is empty')
    }
    return this._latLo
  }

  get latHi(): number {
    if (this._latHi === null) {
      throw new Error('LatLngBounds is empty')
    }
    return this._latHi
  }

  get lngLo(): number {
    if (this._lngLo === null) {
      throw new Error('LatLngBounds is empty')
    }
    return this._lngLo
  }

  get lngHi(): number {
    if (this._lngHi === null) {
      throw new Error('LatLngBounds is empty')
    }
    return this._lngHi
  }

  extend(latDeg: number, lngDeg: number): void {
    const lat = normalizeLat(latDeg)
    const lng = normalizeLng(lngDeg)

    if (!this.isValid()) {
      this._latLo = lat
      this._latHi = lat
      this._lngLo = lng
      this._lngHi = lng
      return
    }

    this._latLo = Math.min(this._latLo!, lat)
    this._latHi = Math.max(this._latHi!, lat)

    if (this.containsLng(lng)) {
      return
    }

    // Expand whichever side adds the smaller angular arc (matching S2 S1Interval.add_point).
    const distLo = positiveDistanceDeg(lng, this._lngLo!)
    const distHi = positiveDistanceDeg(this._lngHi!, lng)
    if (distLo < distHi) {
      this._lngLo = lng
    }
    else {
      this._lngHi = lng
    }
  }

  containsLng(lngDeg: number): boolean {
    if (this._lngLo === null || this._lngHi === null) {
      return false
    }
    const lng = normalizeLng(lngDeg)
    if (this._lngLo <= this._lngHi) {
      return lng >= this._lngLo && lng <= this._lngHi
    }
    return lng >= this._lngLo || lng <= this._lngHi
  }

  contains(latDeg: number, lngDeg: number): boolean {
    if (!this.isValid()) {
      return false
    }
    const lat = normalizeLat(latDeg)
    return lat >= this._latLo! && lat <= this._latHi! && this.containsLng(lngDeg)
  }
}

export function computeTrackBounds(polylines: readonly (readonly LatLngTuple[])[]): LatLngBounds {
  const bounds = new LatLngBounds()
  for (const line of polylines) {
    for (const [lat, lng] of line) {
      bounds.extend(lat, lng)
    }
  }
  return bounds
}

/**
 * Web Mercator X projection in `[0, 2]` (matching Python `gpxtrackposter.utils.lng2x`).
 */
export function lng2x(lngDeg: number): number {
  return lngDeg / 180 + 1
}

/**
 * Web Mercator Y projection (matching Python `gpxtrackposter.utils.lat2y`).
 */
export function lat2y(latDeg: number): number {
  const clamped = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, latDeg))
  return 0.5 - Math.log(Math.tan((Math.PI / 4) * (1 + clamped / 90))) / Math.PI
}

export function latlng2xy(latDeg: number, lngDeg: number): PosterPoint {
  return {
    x: lng2x(lngDeg),
    y: lat2y(latDeg),
  }
}

/**
 * Project `[lat, lng]` polylines into SVG canvas coordinates inside `(offset, offset + size)`.
 * Applies `zoomThreshold` downsampling (`step = floor(len / zoomThreshold) + 1`) to keep
 * generated SVG sizes bounded.
 */
export function projectPolylines(
  bounds: LatLngBounds,
  size: PosterPoint,
  offset: PosterPoint,
  polylines: readonly (readonly LatLngTuple[])[],
  zoomThreshold = DEFAULT_ZOOM_THRESHOLD,
): PosterPoint[][] {
  if (!bounds.isValid() || size.x <= 0 || size.y <= 0) {
    return []
  }

  const minX = lng2x(bounds.lngLo)
  let dx = lng2x(bounds.lngHi) - minX
  while (dx >= 2) {
    dx -= 2
  }
  while (dx < 0) {
    dx += 2
  }

  const minY = lat2y(bounds.latLo)
  const maxY = lat2y(bounds.latHi)
  const dy = Math.abs(maxY - minY)

  if (dx === 0 || dy === 0) {
    return []
  }

  const scale = size.x / size.y <= dx / dy ? size.x / dx : size.y / dy
  const projOffsetX = offset.x + 0.5 * (size.x - scale * dx) - scale * minX
  const projOffsetY = offset.y + 0.5 * (size.y + scale * dy) - scale * minY

  const lines: PosterPoint[][] = []

  for (const latlngLine of polylines) {
    let line: PosterPoint[] = []
    const step = zoomThreshold > 0 ? Math.floor(latlngLine.length / zoomThreshold) + 1 : 1

    for (let i = 0; i < latlngLine.length; i += step) {
      const [lat, lng] = latlngLine[i]
      if (bounds.contains(lat, lng)) {
        let projectedLng = lng
        if (bounds.lngLo > bounds.lngHi && normalizeLng(lng) < bounds.lngLo) {
          projectedLng = normalizeLng(lng) + 360
        }
        line.push({
          x: projOffsetX + scale * lng2x(projectedLng),
          y: projOffsetY + scale * lat2y(lat),
        })
      }
      else if (line.length > 0) {
        lines.push(line)
        line = []
      }
    }

    if (line.length > 0) {
      lines.push(line)
    }
  }

  return lines
}

export interface GridLayout {
  readonly cellSize: number
  readonly counts: readonly [number, number]
}

/**
 * Compute optimal square grid cell size and `(columns, rows)` minimizing unused canvas area.
 * Mathematically equivalent to Python `gpxtrackposter.utils.compute_grid` in O(count) time.
 */
export function computeGrid(count: number, dimensions: PosterPoint): GridLayout | null {
  if (count <= 0 || dimensions.x <= 0 || dimensions.y <= 0) {
    return null
  }

  let minWaste = -1
  let bestSize: number | null = null
  let bestCounts: readonly [number, number] | null = null

  for (let countX = 1; countX <= count; countX++) {
    const countY = Math.ceil(count / countX)
    const size = Math.min(dimensions.x / countX, dimensions.y / countY)
    const waste = dimensions.x * dimensions.y - count * size * size
    if (waste < 0) {
      continue
    }
    if (bestSize === null || waste < minWaste) {
      bestSize = size
      bestCounts = [countX, countY]
      minWaste = waste
    }
  }

  if (bestSize === null || bestCounts === null) {
    return null
  }

  return {
    cellSize: bestSize,
    counts: bestCounts,
  }
}

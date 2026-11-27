import { describe, expect, it } from 'vitest'
import {
  FIXTURE_OUTDOOR_RUN_FLYBY_POINTS,
  FIXTURE_OUTDOOR_RUN_POLYLINE,
} from '../testing/index.js'
import {
  computeGrid,
  computeTrackBounds,
  decodePolyline,
  lat2y,
  latlng2xy,
  LatLngBounds,
  lng2x,
  projectPolylines,
} from './geometry.js'

describe('svg geometry and Mercator projection', () => {
  it('projects geographic coordinates using Web Mercator formulas', () => {
    expect(lng2x(0)).toBeCloseTo(1, 10)
    expect(lng2x(-180)).toBeCloseTo(0, 10)
    expect(lng2x(180)).toBeCloseTo(2, 10)

    expect(lat2y(0)).toBeCloseTo(0.5, 10)
    expect(lat2y(45)).toBeLessThan(0.5)
    expect(lat2y(-45)).toBeGreaterThan(0.5)

    // Clamps extreme polar latitudes without producing Infinity/NaN
    expect(Number.isFinite(lat2y(90))).toBe(true)
    expect(Number.isFinite(lat2y(-90))).toBe(true)

    const pt = latlng2xy(39.944, 116.482)
    expect(pt.x).toBeCloseTo(116.482 / 180 + 1, 10)
    expect(pt.y).toBeGreaterThan(0.2)
    expect(pt.y).toBeLessThan(0.4)
  })

  it('decodes Google-encoded polylines matching the shared outdoor run fixture', () => {
    const decoded = decodePolyline(FIXTURE_OUTDOOR_RUN_POLYLINE)
    expect(decoded).toHaveLength(FIXTURE_OUTDOOR_RUN_FLYBY_POINTS.length)

    for (let i = 0; i < decoded.length; i++) {
      expect(decoded[i][0]).toBeCloseTo(FIXTURE_OUTDOOR_RUN_FLYBY_POINTS[i].lat!, 5)
      expect(decoded[i][1]).toBeCloseTo(FIXTURE_OUTDOOR_RUN_FLYBY_POINTS[i].lng!, 5)
    }

    expect(decodePolyline('')).toEqual([])
  })

  it('computes LatLngBounds validity, center, and diameter', () => {
    const empty = new LatLngBounds()
    expect(empty.isValid()).toBe(false)
    expect(empty.contains(0, 0)).toBe(false)

    const bounds = computeTrackBounds([
      [
        [39.944, 116.482],
        [39.964, 116.496],
      ],
    ])
    expect(bounds.isValid()).toBe(true)
    expect(bounds.latLo).toBe(39.944)
    expect(bounds.latHi).toBe(39.964)
    expect(bounds.lngLo).toBe(116.482)
    expect(bounds.lngHi).toBe(116.496)
    expect(bounds.contains(39.95, 116.49)).toBe(true)
    expect(bounds.contains(40.1, 116.49)).toBe(false)
  })

  it('projects polylines into the target viewport and simplifies dense tracks via zoomThreshold', () => {
    const denseLine: Array<readonly [number, number]> = []
    for (let i = 0; i <= 1000; i++) {
      denseLine.push([39.9 + i * 0.00002, 116.4 + i * 0.00002])
    }

    const bounds = computeTrackBounds([denseLine])
    const size = { x: 20, y: 20 }
    const offset = { x: 10, y: 30 }

    const simplified = projectPolylines(bounds, size, offset, [denseLine])
    expect(simplified).toHaveLength(1)
    // With default zoomThreshold=400, densely packed points are deduplicated to stay bounded
    expect(simplified[0].length).toBeGreaterThan(2)
    expect(simplified[0].length).toBeLessThan(600)

    for (const pt of simplified[0]) {
      expect(pt.x).toBeGreaterThanOrEqual(offset.x - 1e-6)
      expect(pt.x).toBeLessThanOrEqual(offset.x + size.x + 1e-6)
      expect(pt.y).toBeGreaterThanOrEqual(offset.y - 1e-6)
      expect(pt.y).toBeLessThanOrEqual(offset.y + size.y + 1e-6)
    }

    // Disabling simplification keeps all points
    const unsimplified = projectPolylines(bounds, size, offset, [denseLine], 0)
    expect(unsimplified[0]).toHaveLength(denseLine.length)
  })

  it('splits projected polylines when points fall outside bounds', () => {
    const bounds = new LatLngBounds()
    bounds.extend(39.9, 116.4)
    bounds.extend(40.0, 116.5)

    const split = projectPolylines(
      bounds,
      { x: 100, y: 100 },
      { x: 0, y: 0 },
      [[
        [39.91, 116.41],
        [39.92, 116.42],
        [45.0, 120.0], // outside bounds
        [39.98, 116.48],
        [39.99, 116.49],
      ]],
      0,
    )

    expect(split).toHaveLength(2)
    expect(split[0]).toHaveLength(2)
    expect(split[1]).toHaveLength(2)
  })

  it('computes optimal square grid layout minimizing unused canvas area', () => {
    expect(computeGrid(0, { x: 180, y: 240 })).toBeNull()
    expect(computeGrid(10, { x: 0, y: 240 })).toBeNull()
    expect(computeGrid(10, { x: 180, y: -5 })).toBeNull()

    const single = computeGrid(1, { x: 180, y: 240 })
    expect(single).toEqual({ cellSize: 180, counts: [1, 1] })

    const grid4 = computeGrid(4, { x: 100, y: 100 })
    expect(grid4).toEqual({ cellSize: 50, counts: [2, 2] })

    const grid12 = computeGrid(12, { x: 180, y: 240 })
    expect(grid12).toEqual({ cellSize: 60, counts: [3, 4] })

    // Non-trivial count matching real production grid canvas (180 x 240)
    const prod = computeGrid(188, { x: 180, y: 240 })
    expect(prod).not.toBeNull()
    expect(prod!.counts[0] * prod!.counts[1]).toBeGreaterThanOrEqual(188)
    expect(prod!.cellSize * prod!.counts[0]).toBeLessThanOrEqual(180 + 1e-9)
    expect(prod!.cellSize * prod!.counts[1]).toBeLessThanOrEqual(240 + 1e-9)
  })
})

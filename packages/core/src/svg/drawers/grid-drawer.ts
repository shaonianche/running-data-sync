import type { PosterDrawer, PosterPoint, PosterRenderContext, PosterTrack } from '../../contracts/svg.js'
import type { LatLngTuple } from '../geometry.js'
import { resolveDistanceColor } from '../color.js'
import { PosterError } from '../errors.js'
import { computeLengthRanges, formatFloat, metersToUnits, unitLabel } from '../formatting.js'
import { computeGrid, computeTrackBounds, decodePolyline, projectPolylines } from '../geometry.js'
import { svgPolyline } from '../svg-builder.js'
import { parseLocalDateParts } from '../year-range.js'

function resolveTrackPolylines(track: PosterTrack): readonly (readonly LatLngTuple[])[] {
  if (track.polylines && track.polylines.length > 0) {
    return track.polylines
  }
  if (track.summaryPolyline) {
    const decoded = decodePolyline(track.summaryPolyline)
    if (decoded.length > 0) {
      return [decoded]
    }
  }
  return []
}

/**
 * Create a grid poster drawer rendering each track's projected polyline in an optimal
 * square grid layout (newest track top-left, matching Python `GridDrawer`).
 */
export function createGridDrawer(): PosterDrawer {
  return {
    type: 'grid',

    draw(context: PosterRenderContext, size: PosterPoint, offset: PosterPoint): string {
      if (context.tracks.length === 0) {
        throw new PosterError('No tracks to draw.')
      }

      const layout = computeGrid(context.tracks.length, size)
      if (!layout) {
        throw new PosterError('Unable to compute grid.')
      }

      const { cellSize, counts } = layout
      const [countX, countY] = counts
      const spacingX = countX <= 1 ? 0 : (size.x - cellSize * countX) / (countX - 1)
      const spacingY = countY <= 1 ? 0 : (size.y - cellSize * countY) / (countY - 1)
      const gridOffsetX = offset.x + (size.x - countX * cellSize - (countX - 1) * spacingX) / 2
      const gridOffsetY = offset.y + (size.y - countY * cellSize - (countY - 1) * spacingY) / 2

      const { trackLengthRange, dateLengthRange } = computeLengthRanges(context)
      const unit = unitLabel(context.units)
      const cellInnerSize: PosterPoint = {
        x: 0.9 * cellSize,
        y: 0.9 * cellSize,
      }

      const elements: string[] = []
      const total = context.tracks.length

      for (let index = 0; index < total; index++) {
        // Match Python `self.poster.tracks[::-1]` (newest track rendered top-left).
        const track = context.tracks[total - 1 - index]
        const polylines = resolveTrackPolylines(track)
        if (polylines.length === 0) {
          continue
        }

        const bounds = computeTrackBounds(polylines)
        if (!bounds.isValid()) {
          continue
        }

        const col = index % countX
        const row = Math.floor(index / countX)
        const cellOffset: PosterPoint = {
          x: gridOffsetX + 0.05 * cellSize + col * (cellSize + spacingX),
          y: gridOffsetY + 0.05 * cellSize + row * (cellSize + spacingY),
        }

        const projectedLines = projectPolylines(bounds, cellInnerSize, cellOffset, polylines)
        if (projectedLines.length === 0) {
          continue
        }

        const stroke = resolveDistanceColor({
          lengthMeters: track.distance,
          dateLengthRange,
          trackLengthRange,
          theme: context.theme,
          specialDistance: context.specialDistance,
        })
        const datePrefix = parseLocalDateParts(track.startDateLocal)?.dateKey ?? track.startDateLocal.slice(0, 10)
        const strLength = formatFloat(metersToUnits(track.distance, context.units))
        const dateTitle = `${datePrefix} ${strLength}${unit}`

        for (const line of projectedLines) {
          elements.push(
            svgPolyline({
              points: line,
              stroke,
              fill: 'none',
              strokeWidth: 0.5,
              strokeLinejoin: 'round',
              strokeLinecap: 'round',
              title: dateTitle,
              desc: String(track.runId),
            }),
          )
        }
      }

      return elements.join('')
    },
  }
}

export const gridDrawer: PosterDrawer = createGridDrawer()

import type { PosterRenderContext, PosterUnits } from '../contracts/svg.js'
import { ValueRange } from './value-range.js'

const METERS_PER_MILE = 1609.344

export function metersToUnits(meters: number, units: PosterUnits): number {
  if (units === 'metric') {
    return meters * 0.001
  }
  return meters / METERS_PER_MILE
}

export function unitLabel(units: PosterUnits): 'km' | 'mi' {
  return units === 'metric' ? 'km' : 'mi'
}

export function formatFloat(value: number): string {
  return value.toFixed(1)
}

export function formatDistance(meters: number, units: PosterUnits): string {
  return `${formatFloat(metersToUnits(meters, units))} ${unitLabel(units)}`
}

export interface PosterLengthRanges {
  readonly trackLengthRange: ValueRange
  readonly dateLengthRange: ValueRange
}

export function computeLengthRanges(context: PosterRenderContext): PosterLengthRanges {
  const trackLengthRange = new ValueRange()
  for (const track of context.tracks) {
    trackLengthRange.extend(track.distance)
  }

  const dateLengthRange = new ValueRange()
  for (const dayTracks of Object.values(context.tracksByDate)) {
    let dayTotal = 0
    for (const track of dayTracks) {
      dayTotal += track.distance
    }
    dateLengthRange.extend(dayTotal)
  }

  return {
    trackLengthRange,
    dateLengthRange,
  }
}

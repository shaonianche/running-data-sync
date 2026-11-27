import type { PosterDimensions, PosterDrawer, PosterPoint, PosterRenderContext } from '../../contracts/svg.js'
import { resolveDistanceColor } from '../color.js'
import { PosterError } from '../errors.js'
import { computeLengthRanges, formatFloat, metersToUnits, unitLabel } from '../formatting.js'
import { svgRect, svgText } from '../svg-builder.js'
import { formatUtcDateKey, getMondayBasedWeekday } from '../year-range.js'

const DEFAULT_MONTH_NAMES: readonly string[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

const MS_PER_DAY = 86_400_000
const YEAR_FONT_SIZE = (200 * 4.0) / 80.0
const YEAR_LENGTH_FONT_SIZE = (110 * 3.0) / 80.0
const CELL_SIZE = 2.6
const CELL_STEP = 3.5

export interface GithubDrawerOptions {
  readonly monthNames?: readonly string[]
}

export function resolveMonthNames(language?: string): readonly string[] {
  if (!language) {
    return DEFAULT_MONTH_NAMES
  }
  try {
    const formatter = new Intl.DateTimeFormat(language, { month: 'short', timeZone: 'UTC' })
    return Array.from({ length: 12 }, (_, monthIndex) =>
      formatter.format(new Date(Date.UTC(2024, monthIndex, 1))).slice(0, 3))
  }
  catch {
    return DEFAULT_MONTH_NAMES
  }
}

function countActiveYears(context: PosterRenderContext): number {
  let count = 0
  for (const year of context.years) {
    const yearDistance = context.totalDistanceByYear[year] ?? 0
    if (formatFloat(metersToUnits(yearDistance, context.units)) !== '0.0') {
      count++
    }
  }
  return count
}

/**
 * Create a GitHub-contribution-style heatmap poster drawer supporting dark/light themes,
 * multi-year dynamic heights (`55 + realYears * 43`), and `align-firstday` / `align-monday` layouts.
 */
export function createGithubDrawer(options: GithubDrawerOptions = {}): PosterDrawer {
  const monthNames = options.monthNames && options.monthNames.length === 12
    ? options.monthNames
    : DEFAULT_MONTH_NAMES

  return {
    type: 'github',

    computeDimensions(context: PosterRenderContext): PosterDimensions {
      return {
        width: context.width,
        height: 55 + countActiveYears(context) * 43,
      }
    },

    draw(context: PosterRenderContext, _size: PosterPoint, offset: PosterPoint): string {
      if (context.tracks.length === 0) {
        throw new PosterError('No tracks to draw')
      }

      const { trackLengthRange, dateLengthRange } = computeLengthRanges(context)
      const yearStyle = `font-size:${YEAR_FONT_SIZE.toFixed(1)}px; font-family:Arial;`
      const yearLengthStyle = `font-size:${YEAR_LENGTH_FONT_SIZE}px; font-family:Arial;`
      const monthNamesStyle = 'font-size:2.5px; font-family:Arial'
      const unit = unitLabel(context.units)
      const noActivityColor = context.theme.noActivity ?? '#444444'
      const isAlignMonday = context.githubStyle === 'align-monday'

      const elements: string[] = []
      let currentOffsetY = offset.y

      for (let idx = context.years.length - 1; idx >= 0; idx--) {
        const year = context.years[idx]
        const yearDistance = context.totalDistanceByYear[year] ?? 0
        const yearLengthText = formatFloat(metersToUnits(yearDistance, context.units))
        if (yearLengthText === '0.0') {
          continue
        }

        const startDateWeekday = getMondayBasedWeekday(year, 1, 1)
        let cursorMs = Date.UTC(year, 0, 1)
        let firstDayWeekday = startDateWeekday

        if (isAlignMonday) {
          cursorMs -= startDateWeekday * MS_PER_DAY
          firstDayWeekday = 0
        }

        elements.push(
          svgText({
            x: offset.x,
            y: currentOffsetY,
            text: String(year),
            fill: context.theme.text,
            dominantBaseline: 'hanging',
            style: yearStyle,
          }),
        )

        elements.push(
          svgText({
            x: offset.x + 165,
            y: currentOffsetY + 5,
            text: `${yearLengthText} ${unit}`,
            fill: context.theme.text,
            dominantBaseline: 'hanging',
            style: yearLengthStyle,
          }),
        )

        for (let monthIndex = 0; monthIndex < monthNames.length; monthIndex++) {
          elements.push(
            svgText({
              x: offset.x + 15.5 * monthIndex,
              y: currentOffsetY + 14,
              text: monthNames[monthIndex],
              fill: context.theme.text,
              style: monthNamesStyle,
            }),
          )
        }

        let rectX = offset.x
        for (let week = 0; week < 54; week++) {
          const weekdayStart = week === 0 ? firstDayWeekday : 0
          let rectY = week === 0
            ? currentOffsetY + YEAR_FONT_SIZE + 2 + CELL_STEP * weekdayStart
            : currentOffsetY + YEAR_FONT_SIZE + 2

          for (let dayOffset = 0; dayOffset < 7 - weekdayStart; dayOffset++) {
            const currentDate = new Date(cursorMs)
            if (currentDate.getUTCFullYear() > year) {
              break
            }

            rectY += CELL_STEP
            const dateKey = formatUtcDateKey(currentDate)
            let fill = noActivityColor
            let dateTitle = dateKey

            const dayTracks = context.tracksByDate[dateKey]
            if (dayTracks && dayTracks.length > 0) {
              let dayLength = 0
              for (const track of dayTracks) {
                dayLength += track.distance
              }
              fill = resolveDistanceColor({
                lengthMeters: dayLength,
                dateLengthRange,
                trackLengthRange,
                theme: context.theme,
                specialDistance: context.specialDistance,
              })
              const formattedLength = formatFloat(metersToUnits(dayLength, context.units))
              dateTitle = `${dateKey} ${formattedLength} ${unit}`
            }

            elements.push(
              svgRect({
                x: rectX,
                y: rectY,
                width: CELL_SIZE,
                height: CELL_SIZE,
                fill,
                title: dateTitle,
              }),
            )

            cursorMs += MS_PER_DAY
          }

          rectX += CELL_STEP
        }

        currentOffsetY += CELL_STEP * 9 + YEAR_FONT_SIZE + 1.0
      }

      return elements.join('')
    },
  }
}

export const githubDrawer: PosterDrawer = createGithubDrawer()

import type { PosterType } from '@running-data-sync/core'
import type { CliCommandContext } from './context.js'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { ConfigurationError, generatePosterSvg } from '@running-data-sync/core'
import { parseNumberOption, resolveStoreBackedOptions } from './context.js'
import { formatSubcommandHelp } from './help.js'

export async function handleSvg(args: readonly string[], ctx: CliCommandContext): Promise<number> {
  const parsed = parseArgs({
    args: [...args],
    allowPositionals: false,
    strict: true,
    options: {
      'help': { type: 'boolean', short: 'h', default: false },
      'from-db': { type: 'boolean', default: false },
      'gpx-dir': { type: 'string' },
      'type': { type: 'string', default: 'grid' },
      'output': { type: 'string', default: 'poster.svg' },
      'year': { type: 'string', default: 'all' },
      'title': { type: 'string' },
      'athlete': { type: 'string' },
      'language': { type: 'string' },
      'background-color': { type: 'string' },
      'track-color': { type: 'string' },
      'text-color': { type: 'string' },
      'special-color': { type: 'string' },
      'special-color2': { type: 'string' },
      'no-activity': { type: 'string' },
      'special-distance': { type: 'string' },
      'special-distance2': { type: 'string' },
      'min-distance': { type: 'string' },
      'only-run': { type: 'boolean', default: false },
      'with-animation': { type: 'boolean', default: false },
    },
  })

  if (parsed.values.help) {
    ctx.io.stdout(formatSubcommandHelp('svg'))
    return 0
  }

  const posterType = parsed.values.type
  if (posterType !== 'github' && posterType !== 'grid') {
    throw new ConfigurationError(`Unsupported SVG poster type: ${posterType}. Expected "github" or "grid".`)
  }

  const theme = {
    ...(parsed.values['background-color'] ? { background: parsed.values['background-color'] } : {}),
    ...(parsed.values['track-color'] ? { track: parsed.values['track-color'] } : {}),
    ...(parsed.values['text-color'] ? { text: parsed.values['text-color'] } : {}),
    ...(parsed.values['special-color'] ? { special: parsed.values['special-color'] } : {}),
    ...(parsed.values['special-color2'] ? { special2: parsed.values['special-color2'] } : {}),
    ...(parsed.values['no-activity'] ? { noActivity: parsed.values['no-activity'] } : {}),
  }

  const specialDistanceKm = parseNumberOption(parsed.values['special-distance'], '--special-distance')
  const specialDistance2Km = parseNumberOption(parsed.values['special-distance2'], '--special-distance2')
  const minDistanceKm = parseNumberOption(parsed.values['min-distance'], '--min-distance')

  const useDb = parsed.values['from-db'] || !parsed.values['gpx-dir']
  const outputPath = path.resolve(parsed.values.output ?? 'poster.svg')

  const { outputPath: writtenPath } = await generatePosterSvg({
    ...(useDb ? resolveStoreBackedOptions(ctx, true) : { gpxDir: parsed.values['gpx-dir'], formatPort: ctx.deps.createFormatPort?.() }),
    type: posterType as PosterType,
    year: parsed.values.year,
    title: parsed.values.title,
    athlete: parsed.values.athlete,
    language: parsed.values.language,
    minDistanceKm,
    withAnimation: parsed.values['with-animation'],
    onlyRun: useDb && parsed.values['only-run'] ? true : undefined,
    theme: Object.keys(theme).length > 0 ? theme : undefined,
    specialDistance: specialDistanceKm !== undefined || specialDistance2Km !== undefined
      ? {
          specialDistance: specialDistanceKm ?? 10,
          specialDistance2: specialDistance2Km ?? 20,
        }
      : undefined,
    outputPath,
  })

  ctx.io.stdout(`Generated ${posterType} SVG at ${writtenPath ?? outputPath}\n`)
  return 0
}

import type { PosterDrawer, PosterTrack } from '../contracts/svg.js'
import type { Activity } from '../foundation/types.js'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createPosterTrack, FIXTURE_OUTDOOR_RUN_POLYLINE, FIXTURE_POSTER_TRACKS } from '../testing/index.js'
import { activityToPosterTrack } from './adapters.js'
import { ParameterError, PosterError } from './errors.js'
import {
  createSvgPosterGenerator,
  DARK_POSTER_THEME,
  LIGHT_POSTER_THEME,
  renderPosterSvg,
} from './poster.js'

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(CURRENT_DIR, '../../../..')
const WEB_ACTIVITIES_PATH = path.join(REPO_ROOT, 'apps/web/src/static/activities.json')
const WEB_ASSETS_DIR = path.join(REPO_ROOT, 'apps/web/public/assets')
const WEB_PACKAGE_JSON_PATH = path.join(REPO_ROOT, 'apps/web/package.json')

const DETERMINISTIC_MULTI_TIER_TRACKS: readonly PosterTrack[] = [
  createPosterTrack({
    runId: 2001,
    name: 'Easy 5K',
    startDateLocal: '2024-11-10T07:00:00',
    distance: 5200,
    summaryPolyline: FIXTURE_OUTDOOR_RUN_POLYLINE,
  }),
  createPosterTrack({
    runId: 2002,
    name: 'Tempo 12K',
    startDateLocal: '2025-03-15T08:30:00',
    distance: 12400,
    summaryPolyline: FIXTURE_OUTDOOR_RUN_POLYLINE,
  }),
  createPosterTrack({
    runId: 2003,
    name: 'Half Marathon',
    startDateLocal: '2025-03-22T06:45:00',
    distance: 21100,
    summaryPolyline: FIXTURE_OUTDOOR_RUN_POLYLINE,
  }),
]

function normalizeSvgNumbers(svg: string): string {
  return svg
    .replace(/-?\d+\.\d+/g, match => Number(match).toFixed(4))
    .replace(/(\d+)\.0000/g, '$1')
}

describe('svg poster generator (github and grid)', () => {
  it('renders github posters with dynamic multi-year height, dark/light themes, and alignment styles', () => {
    const darkSvg = renderPosterSvg(DETERMINISTIC_MULTI_TIER_TRACKS, {
      type: 'github',
      title: 'Running',
      athlete: 'RUNNER',
      theme: DARK_POSTER_THEME,
      specialDistance: { specialDistance: 10, specialDistance2: 20 },
    })

    // 2 active years (2024, 2025) => height = 55 + 2 * 43 = 141
    expect(darkSvg).toContain('<?xml version="1.0" encoding="utf-8" ?>')
    expect(darkSvg).toContain('viewBox="0,0,200,141"')
    expect(darkSvg).toContain('width="200mm"')
    expect(darkSvg).toContain('height="141mm"')
    expect(darkSvg).toContain('fill="#222222"')
    expect(darkSvg).toContain('>Running</text>')
    expect(darkSvg).toContain('>RUNNER</text>')
    expect(darkSvg).toContain('>Total: 38.7 km</text>')
    expect(darkSvg).toContain('>2024</text>')
    expect(darkSvg).toContain('>2025</text>')
    expect(darkSvg).toContain('<title>2024-11-10 5.2 km</title>')
    expect(darkSvg).toContain('<title>2025-03-15 12.4 km</title>')
    expect(darkSvg).toContain('<title>2025-03-22 21.1 km</title>')
    expect(darkSvg).toContain('fill="red"')

    const lightSvg = renderPosterSvg(DETERMINISTIC_MULTI_TIER_TRACKS, {
      type: 'github',
      title: 'Running',
      athlete: 'RUNNER',
      theme: LIGHT_POSTER_THEME,
      githubStyle: 'align-monday',
      specialDistance: { specialDistance: 10, specialDistance2: 20 },
    })

    expect(lightSvg).toContain('fill="#e5e5e5"')
    expect(lightSvg).toContain('fill="#d4d4d4"')
    expect(lightSvg).toContain('fill="#ff8904"')
    expect(lightSvg).not.toBe(darkSvg)
  })

  it('aggregates multiple runs on the same date in github poster and supports imperial units', () => {
    const sameDayTracks: readonly PosterTrack[] = [
      createPosterTrack({ runId: 3001, startDateLocal: '2025-06-01T07:00:00', distance: 6000 }),
      createPosterTrack({ runId: 3002, startDateLocal: '2025-06-01T18:00:00', distance: 10093.44 }),
    ]

    const svg = renderPosterSvg(sameDayTracks, {
      type: 'github',
      title: 'Miles & More <Test>',
      athlete: 'A & B',
      units: 'imperial',
      theme: DARK_POSTER_THEME,
    })

    // 1 active year => height = 55 + 43 = 98
    expect(svg).toContain('viewBox="0,0,200,98"')
    // Total = 16093.44 m = 10.0 mi
    expect(svg).toContain('<title>2025-06-01 10.0 mi</title>')
    expect(svg).toContain('>10.0 mi</text>')
    expect(svg).toContain('>Miles &amp; More &lt;Test&gt;</text>')
    expect(svg).toContain('>A &amp; B</text>')
  })

  it('renders grid posters newest-first with minDistanceKm filtering, polyline projection, and runId desc', () => {
    const svg = renderPosterSvg(DETERMINISTIC_MULTI_TIER_TRACKS, {
      type: 'grid',
      title: 'Over 10km Runs',
      athlete: 'RUNNER',
      minDistanceKm: 10,
      theme: LIGHT_POSTER_THEME,
      specialDistance: { specialDistance: 10, specialDistance2: 20 },
    })

    expect(svg).toContain('viewBox="0,0,200,300"')
    expect(svg).toContain('fill="#e5e5e5"')
    expect(svg).toContain('>Over 10km Runs</text>')
    // 5.2 km track filtered out; 12.4 km + 21.1 km remain => 33.5 km
    expect(svg).toContain('>Total: 33.5 km</text>')
    expect(svg).not.toContain('<desc>2001</desc>')

    const idx2003 = svg.indexOf('<desc>2003</desc>')
    const idx2002 = svg.indexOf('<desc>2002</desc>')
    expect(idx2003).toBeGreaterThan(-1)
    expect(idx2002).toBeGreaterThan(-1)
    // Newest track (2003) rendered top-left before older track (2002)
    expect(idx2003).toBeLessThan(idx2002)
    expect(svg).toContain('<title>2025-03-22 21.1km</title>')
    expect(svg).toContain('stroke="#ff8904"')
  })

  it('matches deterministic structural snapshots for fixture github and grid posters', () => {
    const githubFixtureSvg = renderPosterSvg(FIXTURE_POSTER_TRACKS, {
      type: 'github',
      title: 'Fixture Github',
      athlete: 'TESTER',
      theme: DARK_POSTER_THEME,
      specialDistance: { specialDistance: 10, specialDistance2: 20 },
    })
    const gridFixtureSvg = renderPosterSvg(FIXTURE_POSTER_TRACKS, {
      type: 'grid',
      title: 'Fixture Grid',
      athlete: 'TESTER',
      theme: LIGHT_POSTER_THEME,
      specialDistance: { specialDistance: 10, specialDistance2: 20 },
    })

    expect({
      viewBox: githubFixtureSvg.match(/viewBox="([^"]+)"/)?.[1],
      rectCount: (githubFixtureSvg.match(/<rect /g) ?? []).length,
      titleCount: (githubFixtureSvg.match(/<title>/g) ?? []).length,
      texts: [...githubFixtureSvg.matchAll(/<text [^>]*>([^<]+)<\/text>/g)].map(m => m[1]),
      activeDates: [...githubFixtureSvg.matchAll(/<title>(\d{4}-\d{2}-\d{2} [^<]+)<\/title>/g)].map(m => m[1]),
    }).toMatchInlineSnapshot(`
      {
        "activeDates": [
          "2025-03-15 5.0 km",
          "2024-11-10 21.1 km",
        ],
        "rectCount": 734,
        "texts": [
          "Fixture Github",
          "Runner",
          "TESTER",
          "SPECIAL TRACKS",
          "Over 10.0 km",
          "Over 20.0 km",
          "STATISTICS",
          "Number: 2",
          "Weekly: 1.0",
          "Total: 26.1 km",
          "Avg: 13.1 km",
          "Min: 5.0 km",
          "Max: 21.1 km",
          "2025",
          "5.0 km",
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
          "2024",
          "21.1 km",
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ],
        "titleCount": 731,
        "viewBox": "0,0,200,141",
      }
    `)

    expect({
      viewBox: gridFixtureSvg.match(/viewBox="([^"]+)"/)?.[1],
      polylineCount: (gridFixtureSvg.match(/<polyline /g) ?? []).length,
      titles: [...gridFixtureSvg.matchAll(/<title>([^<]+)<\/title>/g)].map(m => m[1]),
      descs: [...gridFixtureSvg.matchAll(/<desc>([^<]+)<\/desc>/g)].map(m => m[1]),
      strokes: [...gridFixtureSvg.matchAll(/stroke="([^"]+)"/g)].map(m => m[1]),
      texts: [...gridFixtureSvg.matchAll(/<text [^>]*>([^<]+)<\/text>/g)].map(m => m[1]),
    }).toMatchInlineSnapshot(`
      {
        "descs": [
          "100003",
          "100001",
        ],
        "polylineCount": 2,
        "strokes": [
          "#ff8904",
          "#525252",
        ],
        "texts": [
          "Fixture Grid",
          "Runner",
          "TESTER",
          "SPECIAL TRACKS",
          "Over 10.0 km",
          "Over 20.0 km",
          "STATISTICS",
          "Number: 2",
          "Weekly: 1.0",
          "Total: 26.1 km",
          "Avg: 13.1 km",
          "Min: 5.0 km",
          "Max: 21.1 km",
        ],
        "titles": [
          "2024-11-10 21.1km",
          "2025-03-15 5.0km",
        ],
        "viewBox": "0,0,200,300",
      }
    `)
  })

  it('supports extensible custom PosterDrawer registrations and throws on invalid types/years/empty tracks', () => {
    const generator = createSvgPosterGenerator()
    expect(generator.supportedTypes).toEqual(['github', 'grid'])

    const customDrawer: PosterDrawer = {
      type: 'custom-summary',
      computeDimensions: () => ({ width: 320, height: 180 }),
      draw: (context, size, offset) => (
        `<g data-custom="true" data-count="${context.tracks.length}" data-box="${offset.x},${offset.y},${size.x},${size.y}" />`
      ),
    }

    generator.registerDrawer(customDrawer)
    expect(generator.supportedTypes).toContain('custom-summary')

    const customSvg = generator.render(FIXTURE_POSTER_TRACKS, {
      type: 'custom-summary',
      title: 'Custom',
      athlete: 'DEV',
    })
    expect(customSvg).toContain('viewBox="0,0,320,180"')
    expect(customSvg).toContain('data-custom="true" data-count="2" data-box="10,30,300,120"')

    // Unknown poster type (including unmigrated circular/month_of_life)
    expect(() => generator.render(FIXTURE_POSTER_TRACKS, { type: 'circular' })).toThrow(ParameterError)
    expect(() => generator.render(FIXTURE_POSTER_TRACKS, { type: 'month_of_life' })).toThrow(ParameterError)

    // Invalid year range
    expect(() => generator.render(FIXTURE_POSTER_TRACKS, { type: 'github', year: '2026-2020' })).toThrow(ParameterError)

    // Empty tracks after filtering
    expect(() => generator.render([], { type: 'github' })).toThrow(PosterError)
    expect(() => generator.render(FIXTURE_POSTER_TRACKS, { type: 'grid', minDistanceKm: 100 })).toThrow(PosterError)
  })
})

const HAS_PROD_ASSETS = existsSync(WEB_ACTIVITIES_PATH)
  && existsSync(path.join(WEB_ASSETS_DIR, 'github.svg'))
  && existsSync(path.join(WEB_ASSETS_DIR, 'github-light.svg'))
  && existsSync(path.join(WEB_ASSETS_DIR, 'grid.svg'))
  && existsSync(path.join(WEB_ASSETS_DIR, 'grid-light.svg'))

describe.skipIf(!HAS_PROD_ASSETS)('production asset parity and SVGR compatibility', () => {
  const activities = HAS_PROD_ASSETS
    ? JSON.parse(readFileSync(WEB_ACTIVITIES_PATH, 'utf8')) as Activity[]
    : []
  const runTracks = activities
    .filter(activity => activity.type === 'Run')
    .map(activity => activityToPosterTrack(activity))

  const productionCases = [
    {
      name: 'github.svg',
      options: {
        type: 'github' as const,
        title: 'Running',
        athlete: 'FRIENDSA',
        minDistanceKm: 0.5,
        theme: DARK_POSTER_THEME,
        specialDistance: { specialDistance: 10, specialDistance2: 20 },
      },
    },
    {
      name: 'github-light.svg',
      options: {
        type: 'github' as const,
        title: 'Running',
        athlete: 'FRIENDSA',
        minDistanceKm: 0.5,
        theme: LIGHT_POSTER_THEME,
        specialDistance: { specialDistance: 10, specialDistance2: 20 },
      },
    },
    {
      name: 'grid.svg',
      options: {
        type: 'grid' as const,
        title: 'Over 5km Runs',
        athlete: 'FRIENDSA',
        minDistanceKm: 5,
        theme: DARK_POSTER_THEME,
        specialDistance: { specialDistance: 10, specialDistance2: 20 },
      },
    },
    {
      name: 'grid-light.svg',
      options: {
        type: 'grid' as const,
        title: 'Over 5km Runs',
        athlete: 'FRIENDSA',
        minDistanceKm: 5,
        theme: LIGHT_POSTER_THEME,
        specialDistance: { specialDistance: 10, specialDistance2: 20 },
      },
    },
  ]

  for (const { name, options } of productionCases) {
    it(`matches existing apps/web/public/assets/${name} in stats, years, tiers, aspect ratio, and structure`, () => {
      const generated = renderPosterSvg(runTracks, options)
      const existing = readFileSync(path.join(WEB_ASSETS_DIR, name), 'utf8')

      expect(normalizeSvgNumbers(generated)).toBe(normalizeSvgNumbers(existing))
    })
  }

  it('transforms all 4 generated SVGs cleanly through SVGR + SVGO preserving viewBox and title', async () => {
    const webRequire = createRequire(WEB_PACKAGE_JSON_PATH)
    const svgrPluginEntry = webRequire.resolve('vite-plugin-svgr')
    const svgrRequire = createRequire(svgrPluginEntry)
    const { transform } = svgrRequire('@svgr/core') as {
      transform: (code: string, config: Record<string, unknown>, state: { componentName: string }) => Promise<string>
    }
    const svgoPlugin = webRequire('@svgr/plugin-svgo') as unknown
    const jsxPlugin = svgrRequire('@svgr/plugin-jsx') as unknown

    for (const { name, options } of productionCases) {
      const svg = renderPosterSvg(runTracks, options)
      const jsx = await transform(
        svg,
        {
          exportType: 'named',
          namedExport: 'ReactComponent',
          plugins: [svgoPlugin, jsxPlugin],
          svgoConfig: {
            floatPrecision: 2,
            plugins: [
              {
                name: 'preset-default',
                params: {
                  overrides: {
                    removeTitle: false,
                    removeViewBox: false,
                  },
                },
              },
            ],
          },
        },
        { componentName: 'SvgPoster' },
      )

      expect(jsx, `${name} must preserve viewBox`).toMatch(/viewBox="0 0 200 \d+"/)
      expect(jsx, `${name} must preserve <title> nodes`).toContain('<title>')
      expect(jsx, `${name} must export ReactComponent`).toContain('export { SvgPoster as ReactComponent }')
    }
  })
})

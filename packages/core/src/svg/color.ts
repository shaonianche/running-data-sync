import type { PosterSpecialDistance, PosterTheme } from '../contracts/svg.js'
import type { ValueRange } from './value-range.js'
import { ParameterError } from './errors.js'

/**
 * Standard W3C CSS Color Module Level 3 named colors (matching Python `colour` web colors).
 */
const CSS_NAMED_COLORS: Readonly<Record<string, string>> = {
  aliceblue: '#f0f8ff',
  antiquewhite: '#faebd7',
  aqua: '#00ffff',
  aquamarine: '#7fffd4',
  azure: '#f0ffff',
  beige: '#f5f5dc',
  bisque: '#ffe4c4',
  black: '#000000',
  blanchedalmond: '#ffebcd',
  blue: '#0000ff',
  blueviolet: '#8a2be2',
  brown: '#a52a2a',
  burlywood: '#deb887',
  cadetblue: '#5f9ea0',
  chartreuse: '#7fff00',
  chocolate: '#d2691e',
  coral: '#ff7f50',
  cornflowerblue: '#6495ed',
  cornsilk: '#fff8dc',
  crimson: '#dc143c',
  cyan: '#00ffff',
  darkblue: '#00008b',
  darkcyan: '#008b8b',
  darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9',
  darkgreen: '#006400',
  darkgrey: '#a9a9a9',
  darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b',
  darkolivegreen: '#556b2f',
  darkorange: '#ff8c00',
  darkorchid: '#9932cc',
  darkred: '#8b0000',
  darksalmon: '#e9967a',
  darkseagreen: '#8fbc8f',
  darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f',
  darkslategrey: '#2f4f4f',
  darkturquoise: '#00ced1',
  darkviolet: '#9400d3',
  deeppink: '#ff1493',
  deepskyblue: '#00bfff',
  dimgray: '#696969',
  dimgrey: '#696969',
  dodgerblue: '#1e90ff',
  firebrick: '#b22222',
  floralwhite: '#fffaf0',
  forestgreen: '#228b22',
  fuchsia: '#ff00ff',
  gainsboro: '#dcdcdc',
  ghostwhite: '#f8f8ff',
  gold: '#ffd700',
  goldenrod: '#daa520',
  gray: '#808080',
  green: '#008000',
  greenyellow: '#adff2f',
  grey: '#808080',
  honeydew: '#f0fff0',
  hotpink: '#ff69b4',
  indianred: '#cd5c5c',
  indigo: '#4b0082',
  ivory: '#fffff0',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  lavenderblush: '#fff0f5',
  lawngreen: '#7cfc00',
  lemonchiffon: '#fffacd',
  lightblue: '#add8e6',
  lightcoral: '#f08080',
  lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3',
  lightgreen: '#90ee90',
  lightgrey: '#d3d3d3',
  lightpink: '#ffb6c1',
  lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa',
  lightskyblue: '#87cefa',
  lightslategray: '#778899',
  lightslategrey: '#778899',
  lightsteelblue: '#b0c4de',
  lightyellow: '#ffffe0',
  lime: '#00ff00',
  limegreen: '#32cd32',
  linen: '#faf0e6',
  magenta: '#ff00ff',
  maroon: '#800000',
  mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd',
  mediumorchid: '#ba55d3',
  mediumpurple: '#9370db',
  mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee',
  mediumspringgreen: '#00fa9a',
  mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585',
  midnightblue: '#191970',
  mintcream: '#f5fffa',
  mistyrose: '#ffe4e1',
  moccasin: '#ffe4b5',
  navajowhite: '#ffdead',
  navy: '#000080',
  oldlace: '#fdf5e6',
  olive: '#808000',
  olivedrab: '#6b8e23',
  orange: '#ffa500',
  orangered: '#ff4500',
  orchid: '#da70d6',
  palegoldenrod: '#eee8aa',
  palegreen: '#98fb98',
  paleturquoise: '#afeeee',
  palevioletred: '#db7093',
  papayawhip: '#ffefd5',
  peachpuff: '#ffdab9',
  peru: '#cd853f',
  pink: '#ffc0cb',
  plum: '#dda0dd',
  powderblue: '#b0e0e6',
  purple: '#800080',
  rebeccapurple: '#663399',
  red: '#ff0000',
  rosybrown: '#bc8f8f',
  royalblue: '#4169e1',
  saddlebrown: '#8b4513',
  salmon: '#fa8072',
  sandybrown: '#f4a460',
  seagreen: '#2e8b57',
  seashell: '#fff5ee',
  sienna: '#a0522d',
  silver: '#c0c0c0',
  skyblue: '#87ceeb',
  slateblue: '#6a5acd',
  slategray: '#708090',
  slategrey: '#708090',
  snow: '#fffafa',
  springgreen: '#00ff7f',
  steelblue: '#4682b4',
  tan: '#d2b48c',
  teal: '#008080',
  thistle: '#d8bfd8',
  tomato: '#ff6347',
  turquoise: '#40e0d0',
  violet: '#ee82ee',
  wheat: '#f5deb3',
  white: '#ffffff',
  whitesmoke: '#f5f5f5',
  yellow: '#ffff00',
  yellowgreen: '#9acd32',
}

export type RgbTuple = readonly [number, number, number]
export type HslTuple = readonly [number, number, number]

export function parseColorToRgb(color: string): RgbTuple {
  const normalized = color.trim().toLowerCase()
  const resolved = CSS_NAMED_COLORS[normalized] ?? normalized
  const hex = resolved.startsWith('#') ? resolved.slice(1) : resolved

  if (/^[0-9a-f]{3}$/.test(hex)) {
    const r = Number.parseInt(hex[0] + hex[0], 16) / 255
    const g = Number.parseInt(hex[1] + hex[1], 16) / 255
    const b = Number.parseInt(hex[2] + hex[2], 16) / 255
    return [r, g, b]
  }

  if (/^[0-9a-f]{6}$/.test(hex)) {
    const r = Number.parseInt(hex.slice(0, 2), 16) / 255
    const g = Number.parseInt(hex.slice(2, 4), 16) / 255
    const b = Number.parseInt(hex.slice(4, 6), 16) / 255
    return [r, g, b]
  }

  throw new ParameterError(`Unsupported color format: "${color}"`)
}

export function rgbToHsl(r: number, g: number, b: number): HslTuple {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2

  if (max === min) {
    return [0, 0, l]
  }

  const d = max - min
  const s = l <= 0.5 ? d / (max + min) : d / (2 - max - min)

  let h: number
  if (max === r) {
    h = (g - b) / d + (g < b ? 6 : 0)
  }
  else if (max === g) {
    h = (b - r) / d + 2
  }
  else {
    h = (r - g) / d + 4
  }

  return [h / 6, s, l]
}

export function hslToRgb(h: number, s: number, l: number): RgbTuple {
  if (s === 0) {
    return [l, l, l]
  }

  const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s
  const m1 = 2 * l - m2

  const channel = (hue: number): number => {
    const wrapped = ((hue % 1) + 1) % 1
    if (wrapped < 1 / 6) {
      return m1 + (m2 - m1) * wrapped * 6
    }
    if (wrapped < 0.5) {
      return m2
    }
    if (wrapped < 2 / 3) {
      return m1 + (m2 - m1) * (2 / 3 - wrapped) * 6
    }
    return m1
  }

  return [channel(h + 1 / 3), channel(h), channel(h - 1 / 3)]
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toByte = (v: number): string =>
    Math.min(255, Math.max(0, Math.round(v * 255)))
      .toString(16)
      .padStart(2, '0')
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`
}

/**
 * Linearly interpolate between two CSS colors in HSL space (matching Python `colour.Color`),
 * returning a lowercase 6-digit hex string (`#rrggbb`).
 */
export function interpolateColor(color1: string, color2: string, ratio: number): string {
  const clamped = Math.min(1, Math.max(0, ratio))
  const [r1, g1, b1] = parseColorToRgb(color1)
  const [r2, g2, b2] = parseColorToRgb(color2)
  const [h1, s1, l1] = rgbToHsl(r1, g1, b1)
  const [h2, s2, l2] = rgbToHsl(r2, g2, b2)

  const h = (1 - clamped) * h1 + clamped * h2
  const s = (1 - clamped) * s1 + clamped * s2
  const l = (1 - clamped) * l1 + clamped * l2

  const [r, g, b] = hslToRgb(h, s, l)
  return rgbToHex(r, g, b)
}

/**
 * Resolve track/day stroke or fill color across normal, special1, and special2 distance tiers,
 * matching Python `TracksDrawer.color` + `GithubDrawer` / `GridDrawer` tier logic.
 */
export function resolveDistanceColor(params: {
  lengthMeters: number
  dateLengthRange: ValueRange
  trackLengthRange: ValueRange
  theme: PosterTheme
  specialDistance: PosterSpecialDistance
}): string {
  const { lengthMeters, dateLengthRange, trackLengthRange, theme, specialDistance } = params
  const lengthKm = lengthMeters / 1000

  if (lengthKm >= specialDistance.specialDistance2) {
    return theme.special2 ?? theme.special
  }

  const isSpecial = lengthKm > specialDistance.specialDistance && lengthKm < specialDistance.specialDistance2
  const color1 = isSpecial ? theme.special : theme.track
  const color2 = isSpecial ? (theme.special2 ?? theme.special) : (theme.track2 ?? theme.track)

  const diff = dateLengthRange.diameter()
  if (diff === 0 || !trackLengthRange.isValid()) {
    return color1
  }
  if (trackLengthRange.upper / 1000 < specialDistance.specialDistance2) {
    return color1
  }

  return interpolateColor(color1, color2, (lengthMeters - dateLengthRange.lower) / diff)
}

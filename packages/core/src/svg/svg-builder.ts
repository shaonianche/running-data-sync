import type { PosterPoint } from '../contracts/svg.js'

const XML_ESCAPE_MAP: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&apos;',
}

/**
 * Escape XML special characters for safe embedding in SVG attributes and text nodes.
 */
export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, ch => XML_ESCAPE_MAP[ch] ?? ch)
}

/**
 * Format numeric SVG coordinates cleanly without floating-point artifacts such as `-0`.
 */
export function formatSvgNumber(value: number): string {
  if (Object.is(value, -0) || Math.abs(value) < 1e-12) {
    return '0'
  }
  return String(value)
}

export interface SvgRectOptions {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly fill: string
  readonly title?: string
}

export function svgRect(options: SvgRectOptions): string {
  const attrs = `fill="${escapeXml(options.fill)}" height="${formatSvgNumber(options.height)}" width="${formatSvgNumber(options.width)}" x="${formatSvgNumber(options.x)}" y="${formatSvgNumber(options.y)}"`
  if (options.title !== undefined) {
    return `<rect ${attrs}><title>${escapeXml(options.title)}</title></rect>`
  }
  return `<rect ${attrs} />`
}

export interface SvgTextOptions {
  readonly x: number
  readonly y: number
  readonly text: string
  readonly fill: string
  readonly style: string
  readonly dominantBaseline?: string
}

export function svgText(options: SvgTextOptions): string {
  const baselineAttr = options.dominantBaseline
    ? `dominant-baseline="${escapeXml(options.dominantBaseline)}" `
    : ''
  return `<text ${baselineAttr}fill="${escapeXml(options.fill)}" style="${escapeXml(options.style)}" x="${formatSvgNumber(options.x)}" y="${formatSvgNumber(options.y)}">${escapeXml(options.text)}</text>`
}

export interface SvgPolylineOptions {
  readonly points: readonly PosterPoint[]
  readonly stroke: string
  readonly strokeWidth?: number
  readonly fill?: string
  readonly strokeLinecap?: string
  readonly strokeLinejoin?: string
  readonly title?: string
  readonly desc?: string
}

export function svgPolyline(options: SvgPolylineOptions): string {
  const pointsAttr = options.points
    .map(p => `${formatSvgNumber(p.x)},${formatSvgNumber(p.y)}`)
    .join(' ')
  const fill = options.fill ?? 'none'
  const strokeLinecap = options.strokeLinecap ?? 'round'
  const strokeLinejoin = options.strokeLinejoin ?? 'round'
  const strokeWidth = options.strokeWidth ?? 0.5
  const attrs = `fill="${escapeXml(fill)}" points="${pointsAttr}" stroke="${escapeXml(options.stroke)}" stroke-linecap="${escapeXml(strokeLinecap)}" stroke-linejoin="${escapeXml(strokeLinejoin)}" stroke-width="${formatSvgNumber(strokeWidth)}"`

  const children: string[] = []
  if (options.title !== undefined) {
    children.push(`<title>${escapeXml(options.title)}</title>`)
  }
  if (options.desc !== undefined) {
    children.push(`<desc>${escapeXml(options.desc)}</desc>`)
  }

  if (children.length === 0) {
    return `<polyline ${attrs} />`
  }
  return `<polyline ${attrs}>${children.join('')}</polyline>`
}

export interface SvgDocumentOptions {
  readonly width: number
  readonly height: number
  readonly body: string
}

/**
 * Wrap SVG content in an XML-valid SVG 1.1 document preserving `viewBox`, dimensions,
 * and namespaces compatible with `@svgr/plugin-svgo` and `vite-plugin-svgr`.
 */
export function svgDocument(options: SvgDocumentOptions): string {
  const w = formatSvgNumber(options.width)
  const h = formatSvgNumber(options.height)
  return `<?xml version="1.0" encoding="utf-8" ?>\n<svg baseProfile="full" height="${h}mm" version="1.1" viewBox="0,0,${w},${h}" width="${w}mm" xmlns="http://www.w3.org/2000/svg" xmlns:ev="http://www.w3.org/2001/xml-events" xmlns:xlink="http://www.w3.org/1999/xlink"><defs />${options.body}</svg>`
}

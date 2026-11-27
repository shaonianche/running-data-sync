import type { ParseableActivityFormat, ParsedTrack, ParseTrackOptions } from '../contracts/formats.js'
import { unzipSync } from 'fflate'
import { ParseError } from '../foundation/errors.js'
import { isFitFile } from './fit-adaptor.js'
import { parseFitTrack } from './fit-decoder.js'
import { parseGpxTrack } from './gpx.js'
import { parseTcxTrack } from './tcx.js'

const textDecoder = new TextDecoder('utf-8')

function isZipBytes(data: Uint8Array): boolean {
  return (
    data.length >= 4
    && data[0] === 0x50
    && data[1] === 0x4B
    && (
      (data[2] === 0x03 && data[3] === 0x04)
      || (data[2] === 0x05 && data[3] === 0x06)
      || (data[2] === 0x07 && data[3] === 0x08)
    )
  )
}

function detectFormatFromFileName(fileName?: string): ParseableActivityFormat | null {
  if (!fileName) {
    return null
  }
  const lower = fileName.trim().toLowerCase()
  if (lower.endsWith('.fit')) {
    return 'fit'
  }
  if (lower.endsWith('.zip')) {
    return 'zip'
  }
  if (lower.endsWith('.gpx')) {
    return 'gpx'
  }
  if (lower.endsWith('.tcx')) {
    return 'tcx'
  }
  return null
}

function detectXmlFormat(text: string): 'gpx' | 'tcx' | null {
  const head = text.slice(0, 1024)
  if (/<(?:\w+:)?gpx\b/i.test(head)) {
    return 'gpx'
  }
  if (/<(?:\w+:)?TrainingCenterDatabase\b/i.test(head)) {
    return 'tcx'
  }
  return null
}

function resolveFormat(data: Uint8Array | string, options?: ParseTrackOptions): ParseableActivityFormat {
  if (options?.format) {
    return options.format
  }
  if (data instanceof Uint8Array) {
    if (isZipBytes(data)) {
      return 'zip'
    }
    if (isFitFile(data)) {
      return 'fit'
    }
    const text = textDecoder.decode(data)
    const xmlFmt = detectXmlFormat(text)
    if (xmlFmt) {
      return xmlFmt
    }
    const fromName = detectFormatFromFileName(options?.fileName)
    if (fromName) {
      return fromName
    }
    throw new ParseError('Unable to detect activity track format from binary payload')
  }

  const xmlFmt = detectXmlFormat(data)
  if (xmlFmt) {
    return xmlFmt
  }
  const fromName = detectFormatFromFileName(options?.fileName)
  if (fromName) {
    return fromName
  }
  throw new ParseError('Unable to detect activity track format from text payload')
}

function extractSupportedZipEntry(zipBytes: Uint8Array): { name: string, format: 'fit' | 'gpx' | 'tcx', data: Uint8Array } {
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zipBytes)
  }
  catch (err) {
    throw new ParseError(`Failed to extract ZIP archive: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    })
  }

  const candidates = Object.entries(entries).filter(([name]) => {
    if (name.endsWith('/') || name.startsWith('__MACOSX/')) {
      return false
    }
    const base = name.split('/').pop() ?? name
    return !base.startsWith('._')
  })

  for (const ext of ['fit', 'gpx', 'tcx'] as const) {
    const match = candidates.find(([name]) => name.toLowerCase().endsWith(`.${ext}`))
    if (match) {
      return { name: match[0], format: ext, data: match[1] }
    }
  }

  // Fallback: inspect payload bytes for FIT header when filename has no standard extension.
  for (const [name, content] of candidates) {
    if (isFitFile(content)) {
      return { name, format: 'fit', data: content }
    }
  }

  throw new ParseError('ZIP archive does not contain a supported .fit, .gpx, or .tcx file')
}

/**
 * Parse a `.fit`, `.zip` (containing `.fit`/`.gpx`/`.tcx`), `.gpx`, or `.tcx` payload into a `ParsedTrack`.
 */
export async function parseTrack(
  data: Uint8Array | string,
  options?: ParseTrackOptions,
): Promise<ParsedTrack> {
  const format = resolveFormat(data, options)

  if (format === 'zip') {
    if (!(data instanceof Uint8Array)) {
      throw new ParseError('ZIP track payload must be a Uint8Array')
    }
    const extracted = extractSupportedZipEntry(data)
    const nestedOptions: ParseTrackOptions = {
      format: extracted.format,
      fileName: options?.fileName ?? extracted.name,
    }
    if (extracted.format === 'fit') {
      return parseFitTrack(extracted.data, nestedOptions)
    }
    const xml = textDecoder.decode(extracted.data)
    return extracted.format === 'gpx'
      ? parseGpxTrack(xml, nestedOptions)
      : parseTcxTrack(xml, nestedOptions)
  }

  if (format === 'fit') {
    if (!(data instanceof Uint8Array)) {
      throw new ParseError('FIT track payload must be a Uint8Array')
    }
    return parseFitTrack(data, options)
  }

  const xmlText = typeof data === 'string' ? data : textDecoder.decode(data)
  if (format === 'gpx') {
    return parseGpxTrack(xmlText, options)
  }
  if (format === 'tcx') {
    return parseTcxTrack(xmlText, options)
  }

  throw new ParseError(`Unsupported activity format: ${String(format)}`)
}

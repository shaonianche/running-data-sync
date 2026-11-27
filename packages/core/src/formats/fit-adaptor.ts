import type { Mesg } from '@garmin/fitsdk'
import type { FitAdaptOptions } from '../contracts/formats.js'
import { Decoder, Encoder, Profile, Stream } from '@garmin/fitsdk'
import { ParseError } from '../foundation/errors.js'
import {
  DEFAULT_GARMIN_MANUFACTURER,
  DEFAULT_GARMIN_PRODUCT_ID,
  DEFAULT_GARMIN_SERIAL_NUMBER,
  DEFAULT_GARMIN_SOFTWARE_VERSION,
} from './fit-mapping.js'

const INVALID_HEART_RATE = 255
const DEVICE_SOURCE_LOCAL = 5

interface CapturedFitMessage {
  readonly mesgNum: number
  mesg: Record<string, unknown>
}

interface ProfileMessageDefinition {
  readonly fields?: Record<string, { readonly name?: string }>
}

const KNOWN_FIELD_NAMES_CACHE = new Map<number, ReadonlySet<string>>()

function getKnownFieldNames(mesgNum: number): ReadonlySet<string> | null {
  const cached = KNOWN_FIELD_NAMES_CACHE.get(mesgNum)
  if (cached) {
    return cached
  }
  const profileMessages = Profile.messages as Record<number, ProfileMessageDefinition | undefined>
  const definition = profileMessages[mesgNum]
  if (!definition?.fields) {
    return null
  }
  const names = new Set<string>()
  for (const field of Object.values(definition.fields)) {
    if (field?.name) {
      names.add(field.name)
    }
  }
  KNOWN_FIELD_NAMES_CACHE.set(mesgNum, names)
  return names
}

function sanitizeMessageForEncoder(mesgNum: number, mesg: Record<string, unknown>): Record<string, unknown> | null {
  // Drop developer data definitions because developerFields are not preserved across re-encode.
  if (mesgNum === Profile.MesgNum.DEVELOPER_DATA_ID || mesgNum === Profile.MesgNum.FIELD_DESCRIPTION) {
    return null
  }
  const knownFields = getKnownFieldNames(mesgNum)
  if (!knownFields) {
    return null
  }
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(mesg)) {
    if (value === undefined || !knownFields.has(key)) {
      continue
    }
    clean[key] = value
  }
  return clean
}

function isValidHeartRate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < INVALID_HEART_RATE
}

function findNearestValidHeartRate(
  records: readonly Record<string, unknown>[],
  currentIndex: number,
): number | null {
  for (let i = currentIndex + 1; i < records.length; i++) {
    const hr = records[i].heartRate
    if (isValidHeartRate(hr)) {
      return hr
    }
  }
  for (let i = currentIndex - 1; i >= 0; i--) {
    const hr = records[i].heartRate
    if (isValidHeartRate(hr)) {
      return hr
    }
  }
  return null
}

/**
 * Check whether `data` is a valid FIT binary payload using official `@garmin/fitsdk` `Decoder.isFIT()`.
 */
export function isFitFile(data: Uint8Array): boolean {
  if (!(data instanceof Uint8Array) || data.length < 12) {
    return false
  }
  try {
    const decoder = new Decoder(Stream.fromByteArray(data))
    return decoder.isFIT()
  }
  catch {
    return false
  }
}

/**
 * Post-process an existing `.fit` binary via official `@garmin/fitsdk` `Decoder` + `Encoder` round-trip.
 *
 * - `useFakeGarminDevice`: replaces existing `device_info` messages with a Garmin device profile
 *   (defaults to Garmin Forerunner 245 / product `3589`, software `5.5`, serial `1234567890`).
 * - `fixHeartRate`: fills missing (`undefined`/`null`) or invalid (`255`) record heart rates from
 *   the nearest valid forward record, falling back to the nearest valid preceding record.
 */
export function adaptFit(fitData: Uint8Array, options: FitAdaptOptions): Uint8Array {
  if (!(fitData instanceof Uint8Array) || fitData.length === 0) {
    throw new ParseError('Cannot adapt empty FIT payload')
  }

  const checkDecoder = new Decoder(Stream.fromByteArray(fitData))
  if (!checkDecoder.isFIT()) {
    throw new ParseError('Input buffer is not a valid FIT file')
  }
  if (!checkDecoder.checkIntegrity()) {
    throw new ParseError('Input FIT file failed integrity check')
  }

  const useFakeGarminDevice = Boolean(options.useFakeGarminDevice)
  const fixHeartRate = Boolean(options.fixHeartRate)

  if (!useFakeGarminDevice && !fixHeartRate) {
    return Uint8Array.from(fitData)
  }

  const captured: CapturedFitMessage[] = []
  const decoder = new Decoder(Stream.fromByteArray(fitData))
  const { errors } = decoder.read({
    expandSubFields: false,
    expandComponents: false,
    mergeHeartRates: false,
    convertTypesToStrings: false,
    convertDateTimesToDates: false,
    mesgListener: (mesgNum: number, mesg: Mesg) => {
      captured.push({ mesgNum, mesg: { ...(mesg as Record<string, unknown>) } })
    },
  })

  if (errors && errors.length > 0) {
    throw new ParseError(`Failed to decode FIT file for adaptation: ${errors.map(String).join('; ')}`)
  }

  if (fixHeartRate) {
    const recordIndices: number[] = []
    const originalRecords: Record<string, unknown>[] = []
    for (let i = 0; i < captured.length; i++) {
      if (captured[i].mesgNum === Profile.MesgNum.RECORD) {
        recordIndices.push(i)
        originalRecords.push(captured[i].mesg)
      }
    }

    for (let idx = 0; idx < recordIndices.length; idx++) {
      const record = originalRecords[idx]
      if (!isValidHeartRate(record.heartRate)) {
        const replacement = findNearestValidHeartRate(originalRecords, idx)
        const updated = { ...record }
        if (replacement !== null) {
          updated.heartRate = replacement
        }
        else {
          delete updated.heartRate
        }
        captured[recordIndices[idx]].mesg = updated
      }
    }
  }

  let outputMessages: CapturedFitMessage[] = captured
  if (useFakeGarminDevice) {
    let deviceTimestamp: unknown
    let fileCreatedTimestamp: unknown
    let firstRecordTimestamp: unknown

    for (let i = 0; i < captured.length; i++) {
      const entry = captured[i]
      if (entry.mesgNum === Profile.MesgNum.DEVICE_INFO) {
        if (deviceTimestamp === undefined && entry.mesg.timestamp !== undefined) {
          deviceTimestamp = entry.mesg.timestamp
        }
      }
      else if (entry.mesgNum === Profile.MesgNum.FILE_ID && fileCreatedTimestamp === undefined) {
        fileCreatedTimestamp = entry.mesg.timeCreated
      }
      else if (entry.mesgNum === Profile.MesgNum.RECORD && firstRecordTimestamp === undefined) {
        firstRecordTimestamp = entry.mesg.timestamp
      }
    }

    const filtered: CapturedFitMessage[] = []
    let insertAt = -1
    for (let i = 0; i < captured.length; i++) {
      const entry = captured[i]
      if (entry.mesgNum === Profile.MesgNum.DEVICE_INFO) {
        if (insertAt === -1) {
          insertAt = filtered.length
        }
        continue
      }
      filtered.push(entry)
    }

    const deviceInfoMesg: Record<string, unknown> = {
      deviceIndex: 0,
      manufacturer: options.manufacturer ?? DEFAULT_GARMIN_MANUFACTURER,
      product: options.productId ?? DEFAULT_GARMIN_PRODUCT_ID,
      serialNumber: options.serialNumber ?? DEFAULT_GARMIN_SERIAL_NUMBER,
      softwareVersion: options.softwareVersion ?? DEFAULT_GARMIN_SOFTWARE_VERSION,
      sourceType: DEVICE_SOURCE_LOCAL,
    }
    const resolvedTimestamp = deviceTimestamp ?? fileCreatedTimestamp ?? firstRecordTimestamp
    if (resolvedTimestamp !== undefined) {
      deviceInfoMesg.timestamp = resolvedTimestamp
    }

    if (insertAt === -1) {
      const fileCreatorIdx = filtered.findIndex(e => e.mesgNum === Profile.MesgNum.FILE_CREATOR)
      const fileIdIdx = filtered.findIndex(e => e.mesgNum === Profile.MesgNum.FILE_ID)
      if (fileCreatorIdx !== -1) {
        insertAt = fileCreatorIdx + 1
      }
      else if (fileIdIdx !== -1) {
        insertAt = fileIdIdx + 1
      }
      else {
        insertAt = filtered.length
      }
    }

    filtered.splice(insertAt, 0, {
      mesgNum: Profile.MesgNum.DEVICE_INFO,
      mesg: deviceInfoMesg,
    })
    outputMessages = filtered
  }

  const encoder = new Encoder()
  for (const { mesgNum, mesg } of outputMessages) {
    const clean = sanitizeMessageForEncoder(mesgNum, mesg)
    if (!clean) {
      continue
    }
    encoder.onMesg(mesgNum, clean)
  }

  return encoder.close()
}

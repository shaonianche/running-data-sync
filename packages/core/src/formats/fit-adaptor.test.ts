import type {
  ActivityMesg,
  DeviceInfoMesg,
  FileIdMesg,
  RecordMesg,
  SessionMesg,
} from '@garmin/fitsdk'
import { Decoder, Encoder, Profile, Stream } from '@garmin/fitsdk'
import { describe, expect, it } from 'vitest'
import { ParseError } from '../foundation/errors.js'
import {
  adaptFit,
  DEFAULT_GARMIN_MANUFACTURER,
  DEFAULT_GARMIN_PRODUCT_ID,
  DEFAULT_GARMIN_SERIAL_NUMBER,
  DEFAULT_GARMIN_SOFTWARE_VERSION,
  isFitFile,
} from './index.js'

function buildThirdPartyFitFixture(heartRates: ReadonlyArray<number | null>): Uint8Array {
  const start = new Date('2025-06-01T00:00:00Z')
  const end = new Date(start.getTime() + Math.max(1, heartRates.length - 1) * 10_000)
  const encoder = new Encoder()

  const fileId: FileIdMesg = {
    type: 'activity',
    manufacturer: 'wahooFitness',
    product: 100,
    serialNumber: 999999,
    timeCreated: start,
  }
  encoder.onMesg(Profile.MesgNum.FILE_ID, fileId)

  const deviceInfo: DeviceInfoMesg = {
    timestamp: start,
    deviceIndex: 0,
    manufacturer: 'wahooFitness',
    product: 100,
    serialNumber: 999999,
    softwareVersion: 1.2,
    sourceType: 'local',
  }
  encoder.onMesg(Profile.MesgNum.DEVICE_INFO, deviceInfo)

  for (let i = 0; i < heartRates.length; i++) {
    const rec: RecordMesg = {
      timestamp: new Date(start.getTime() + i * 10_000),
      distance: i * 35,
      speed: 3.5,
      enhancedSpeed: 3.5,
      altitude: 20 + i,
      enhancedAltitude: 20 + i,
    }
    const hr = heartRates[i]
    if (hr !== null) {
      rec.heartRate = hr
    }
    encoder.onMesg(Profile.MesgNum.RECORD, rec)
  }

  const session: SessionMesg = {
    timestamp: end,
    startTime: start,
    totalElapsedTime: Math.max(10, (heartRates.length - 1) * 10),
    totalTimerTime: Math.max(10, (heartRates.length - 1) * 10),
    totalDistance: Math.max(0, (heartRates.length - 1) * 35),
    sport: 'running',
    subSport: 'street',
    numLaps: 1,
    firstLapIndex: 0,
    event: 'session',
    eventType: 'stop',
    trigger: 'activityEnd',
  }
  encoder.onMesg(Profile.MesgNum.SESSION, session)

  const activity: ActivityMesg = {
    timestamp: end,
    totalTimerTime: Math.max(10, (heartRates.length - 1) * 10),
    numSessions: 1,
    type: 'manual',
    event: 'activity',
    eventType: 'stop',
  }
  encoder.onMesg(Profile.MesgNum.ACTIVITY, activity)

  return encoder.close()
}

function decodeStrict(bytes: Uint8Array) {
  const decoder = new Decoder(Stream.fromByteArray(bytes))
  expect(decoder.isFIT()).toBe(true)
  expect(decoder.checkIntegrity()).toBe(true)
  const { messages, errors } = decoder.read()
  expect(errors).toEqual([])
  return messages
}

describe('fit-adaptor (isFitFile and adaptFit)', () => {
  it('detects valid vs invalid FIT payloads via official Decoder.isFIT()', () => {
    const validFit = buildThirdPartyFitFixture([145, 150])
    expect(isFitFile(validFit)).toBe(true)
    expect(isFitFile(new Uint8Array(0))).toBe(false)
    expect(isFitFile(new Uint8Array([1, 2, 3, 4]))).toBe(false)
    expect(isFitFile(new TextEncoder().encode('<gpx version="1.1"></gpx>'))).toBe(false)
  })

  it('replaces third-party DEVICE_INFO with default Garmin Forerunner 245 metadata', () => {
    const raw = buildThirdPartyFitFixture([140, 148, 155])
    const adapted = adaptFit(raw, { useFakeGarminDevice: true })
    const messages = decodeStrict(adapted)

    expect(messages.deviceInfoMesgs).toHaveLength(1)
    expect(messages.deviceInfoMesgs?.[0]).toMatchObject({
      manufacturer: 'garmin',
      product: DEFAULT_GARMIN_PRODUCT_ID,
      serialNumber: DEFAULT_GARMIN_SERIAL_NUMBER,
      softwareVersion: DEFAULT_GARMIN_SOFTWARE_VERSION,
      sourceType: 'local',
    })
    expect(messages.recordMesgs?.map(r => r.heartRate)).toEqual([140, 148, 155])
    expect(messages.sessionMesgs?.[0]?.totalDistance).toBeCloseTo(70, 2)
  })

  it('supports custom Garmin device metadata overrides', () => {
    const raw = buildThirdPartyFitFixture([142, 146])
    const adapted = adaptFit(raw, {
      useFakeGarminDevice: true,
      manufacturer: DEFAULT_GARMIN_MANUFACTURER,
      productId: 3906,
      softwareVersion: 14.2,
      serialNumber: 3344556677,
    })
    const messages = decodeStrict(adapted)

    expect(messages.deviceInfoMesgs).toHaveLength(1)
    expect(messages.deviceInfoMesgs?.[0]).toMatchObject({
      manufacturer: 'garmin',
      product: 3906,
      softwareVersion: 14.2,
      serialNumber: 3344556677,
    })
  })

  it('repairs leading nulls from the first subsequent valid HR', () => {
    const raw = buildThirdPartyFitFixture([null, null, 144, 150])
    const adapted = adaptFit(raw, { fixHeartRate: true })
    const messages = decodeStrict(adapted)

    expect(messages.recordMesgs?.map(r => r.heartRate)).toEqual([144, 144, 144, 150])
  })

  it('repairs trailing nulls from the nearest preceding valid HR', () => {
    const raw = buildThirdPartyFitFixture([138, 149, null, null])
    const adapted = adaptFit(raw, { fixHeartRate: true })
    const messages = decodeStrict(adapted)

    expect(messages.recordMesgs?.map(r => r.heartRate)).toEqual([138, 149, 149, 149])
  })

  it('repairs mid-stream 255 sentinel and null HR using forward-first nearest valid HR', () => {
    const raw = buildThirdPartyFitFixture([140, 255, 152, null, 164, 255])
    const adapted = adaptFit(raw, { fixHeartRate: true })
    const messages = decodeStrict(adapted)

    // Index 1 (255) -> forward 152; index 3 (null) -> forward 164; index 5 (255) -> backward 164
    expect(messages.recordMesgs?.map(r => r.heartRate)).toEqual([140, 152, 152, 164, 164, 164])
  })

  it('handles all-invalid HR (null and 255 only) without crashing or inventing values', () => {
    const raw = buildThirdPartyFitFixture([null, 255, null, 255])
    const adapted = adaptFit(raw, { fixHeartRate: true })
    const messages = decodeStrict(adapted)

    expect(messages.recordMesgs).toHaveLength(4)
    for (const rec of messages.recordMesgs ?? []) {
      expect(rec.heartRate).toBeUndefined()
    }
  })

  it('applies useFakeGarminDevice and fixHeartRate together in a single round-trip', () => {
    const raw = buildThirdPartyFitFixture([null, 150, 255, 160])
    const adapted = adaptFit(raw, {
      useFakeGarminDevice: true,
      fixHeartRate: true,
    })
    const messages = decodeStrict(adapted)

    expect(messages.deviceInfoMesgs?.[0]).toMatchObject({
      manufacturer: 'garmin',
      product: DEFAULT_GARMIN_PRODUCT_ID,
      serialNumber: DEFAULT_GARMIN_SERIAL_NUMBER,
    })
    expect(messages.recordMesgs?.map(r => r.heartRate)).toEqual([150, 150, 160, 160])
  })

  it('returns an intact copy when neither option is enabled and rejects corrupted FIT payloads', () => {
    const raw = buildThirdPartyFitFixture([145, 150])
    const unchanged = adaptFit(raw, { useFakeGarminDevice: false, fixHeartRate: false })
    expect(unchanged).toEqual(raw)
    expect(unchanged).not.toBe(raw)

    // Corrupt a payload byte so CRC integrity fails
    const corrupted = Uint8Array.from(raw)
    corrupted[corrupted.length - 5] ^= 0xFF
    expect(() => adaptFit(corrupted, { useFakeGarminDevice: true })).toThrow(ParseError)
    expect(() => adaptFit(new Uint8Array(0), { fixHeartRate: true })).toThrow(ParseError)
    expect(() => adaptFit(new TextEncoder().encode('not-fit'), { fixHeartRate: true })).toThrow(ParseError)
  })
})

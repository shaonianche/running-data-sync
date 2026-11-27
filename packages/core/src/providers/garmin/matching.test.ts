import type { GarminActivityRecord, GarminClientLike } from './types.js'
import { describe, expect, it } from 'vitest'
import {
  createIndoorWorkoutActivity,
  createOutdoorRunActivity,
  createOutdoorRunFlybyPoints,
  createVendorSyncRow,
  InMemoryActivityStore,
} from '../../testing/index.js'
import {
  computeActivityContentHash,
  extractGarminTypeKey,
  extractRemoteActivityIdFromUploadResult,
  findMatchingGarminActivity,
  getStravaTypeAliases,
  parseGarminDurationSeconds,
  parseGarminStartTime,
  preferDurationMatch,
} from './matching.js'
import { reconcileGarmin } from './sync.js'

function createFakeClient(remoteActivities: GarminActivityRecord[], isCn = false): GarminClientLike {
  return {
    domain: isCn ? 'garmin.cn' : 'garmin.com',
    account: isCn ? 'garmin_cn' : 'garmin_com',
    getActivities: async () => remoteActivities,
    fetchAllActivities: async () => remoteActivities,
    getActivitySummary: async () => ({}),
    deleteActivity: async () => {},
    downloadActivity: async () => new Uint8Array(),
    uploadActivity: async () => ({
      status: 200,
      detailedImportResult: null,
      remoteActivityId: null,
      duplicate: false,
    }),
  }
}

describe('garmin activity matching & content hashing', () => {
  it('parses Garmin timestamps, durations, types, and upload result IDs', () => {
    expect(parseGarminStartTime('2024-03-15 06:30:00')).toBe(Date.UTC(2024, 2, 15, 6, 30, 0))
    expect(parseGarminStartTime('2024-03-15T06:30:00Z')).toBe(Date.UTC(2024, 2, 15, 6, 30, 0))
    expect(parseGarminStartTime('')).toBeNull()

    expect(parseGarminDurationSeconds({ elapsedDuration: 1805 })).toBe(1805)
    expect(parseGarminDurationSeconds({ movingDurationInSeconds: 1200 })).toBe(1200)
    expect(parseGarminDurationSeconds({})).toBeNull()

    expect(extractGarminTypeKey({ activityType: { typeKey: 'Trail_Running' } })).toBe('trail_running')
    expect(extractGarminTypeKey({ activityTypeDTO: { typeKey: 'strength_training' } })).toBe('strength_training')

    expect(getStravaTypeAliases('Run').has('treadmill_running')).toBe(true)
    expect(getStravaTypeAliases('CustomSport').has('customsport')).toBe(true)

    // Primary activityId takes precedence over secondary internalId
    expect(
      extractRemoteActivityIdFromUploadResult({
        successes: [{ internalId: 111, activityId: 222 }],
      }),
    ).toBe(222)
    expect(
      extractRemoteActivityIdFromUploadResult({
        successes: [{ internalId: 333 }],
      }),
    ).toBe(333)
  })

  it('matches outdoor runs distance-first and indoor workouts duration-first while respecting reserved IDs', () => {
    const outdoorRun = createOutdoorRunActivity({
      run_id: 1001,
      start_date: '2024-03-15 06:30:00',
      distance: 10_000,
      moving_time: 3000,
      elapsed_time: 3020,
      type: 'Run',
    })
    expect(preferDurationMatch(outdoorRun)).toBe(false)

    const remoteCandidates: GarminActivityRecord[] = [
      // Wrong sport type even though start time and distance match
      {
        activityId: 5001,
        startTimeGMT: '2024-03-15 06:30:00',
        distance: 10_000,
        activityType: { typeKey: 'cycling' },
      },
      // Within 300s window and 50m distance tolerance, closer time delta wins
      {
        activityId: 5002,
        startTimeGMT: '2024-03-15 06:31:00',
        distance: 10_010,
        activityType: { typeKey: 'running' },
      },
      {
        activityId: 5003,
        startTimeGMT: '2024-03-15 06:30:10',
        distance: 10_025,
        activityType: { typeKey: 'street_running' },
      },
      // Outside 50m tolerance
      {
        activityId: 5004,
        startTimeGMT: '2024-03-15 06:30:00',
        distance: 10_200,
        activityType: { typeKey: 'running' },
      },
    ]

    expect(findMatchingGarminActivity(outdoorRun, remoteCandidates)).toBe(5003)
    expect(
      findMatchingGarminActivity(outdoorRun, remoteCandidates, {
        reservedActivityIds: new Set([5003]),
      }),
    ).toBe(5002)

    const indoorWorkout = createIndoorWorkoutActivity({
      run_id: 2001,
      start_date: '2024-03-16 18:00:00',
      distance: 0,
      moving_time: 2700,
      elapsed_time: 2700,
      type: 'WeightTraining',
    })
    expect(preferDurationMatch(indoorWorkout)).toBe(true)

    const indoorMatch = findMatchingGarminActivity(indoorWorkout, [
      {
        activityId: 6001,
        startTimeGMT: '2024-03-16 18:00:15',
        distance: 0,
        duration: 2750,
        activityType: { typeKey: 'strength_training' },
      },
      {
        activityId: 6002,
        startTimeGMT: '2024-03-16 18:00:05',
        distance: 0,
        duration: 3200, // Outside 120s tolerance
        activityType: { typeKey: 'strength_training' },
      },
    ])
    expect(indoorMatch).toBe(6001)
  })

  it('computes a deterministic SHA-256 content hash independent of flyby point ordering', () => {
    const activity = createOutdoorRunActivity()
    const points = createOutdoorRunFlybyPoints()
    const reversed = [...points].reverse()

    const hashA = computeActivityContentHash(activity, points)
    const hashB = computeActivityContentHash(activity, reversed)
    const hashModified = computeActivityContentHash({ ...activity, distance: activity.distance + 1 }, points)

    expect(hashA).toMatch(/^[0-9a-f]{64}$/)
    expect(hashA).toBe(hashB)
    expect(hashModified).not.toBe(hashA)
  })
})

describe('reconcileGarmin', () => {
  it('marks matched activities synced, deleted remote activities missing_remote, and leaves unsynced unmatched rows unchanged', async () => {
    const matchedRun = createOutdoorRunActivity({
      run_id: 101,
      start_date: '2024-03-15 06:30:00',
      distance: 10_000,
      type: 'Run',
    })
    const deletedRemoteRun = createOutdoorRunActivity({
      run_id: 102,
      start_date: '2024-03-16 06:30:00',
      distance: 5000,
      type: 'Run',
    })
    const neverSyncedRun = createOutdoorRunActivity({
      run_id: 103,
      start_date: '2024-03-17 06:30:00',
      distance: 8000,
      type: 'Run',
    })

    const store = new InMemoryActivityStore({
      activities: [matchedRun, deletedRemoteRun, neverSyncedRun],
      vendorSyncRows: [
        createVendorSyncRow({
          activityId: 102,
          vendor: 'garmin',
          account: 'garmin_com',
          status: 'synced',
          remoteActivityId: 999999,
          contentHash: 'old-hash',
          attemptCount: 1,
        }),
      ],
    })

    const client = createFakeClient([
      {
        activityId: 800101,
        startTimeGMT: '2024-03-15 06:30:10',
        distance: 10_005,
        activityType: { typeKey: 'running' },
      },
    ])

    const result = await reconcileGarmin({
      store,
      client,
      now: () => Date.UTC(2024, 2, 20, 12, 0, 0),
    })

    expect(result).toEqual({
      account: 'garmin_com',
      totalLocal: 3,
      totalRemote: 1,
      matched: 1,
      missingRemote: 1,
      unchanged: 1,
    })

    const row101 = await store.getVendorSyncRow(101, 'garmin', 'garmin_com')
    expect(row101?.status).toBe('synced')
    expect(row101?.remoteActivityId).toBe(800101)
    expect(row101?.lastVerifiedAt).toBe('2024-03-20T12:00:00.000Z')

    const row102 = await store.getVendorSyncRow(102, 'garmin', 'garmin_com')
    expect(row102?.status).toBe('missing_remote')
    expect(row102?.remoteActivityId).toBe(999999)

    const row103 = await store.getVendorSyncRow(103, 'garmin', 'garmin_com')
    expect(row103).toBeNull()
  })
})

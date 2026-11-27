import type { ReverseGeocoder, StravaStreamsMap, StravaSummaryActivity } from './types.js'
import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '../../foundation/logger.js'
import {
  convertStreamsToFlybyPoints,
  mapStravaActivities,
  mapStravaActivity,
} from './mapper.js'

const silentLogger = createLogger('test.mapper', { sink: () => {} })

describe('mapStravaActivity & mapStravaActivities', () => {
  it('maps core Strava fields including type/sport_type/subtype, timestamps, and polyline', () => {
    const raw: StravaSummaryActivity = {
      id: 21130074009,
      name: 'Morning Trail Run',
      distance: 10540.5,
      moving_time: 3120,
      elapsed_time: 3250,
      total_elevation_gain: 185.4,
      type: 'Run',
      sport_type: 'TrailRun',
      start_date: '2026-11-26T07:38:07Z',
      start_date_local: '2026-11-26T15:38:07Z',
      location_country: 'Japan',
      map: { summary_polyline: '_p~iF~ps|U_ulLnnqC' },
      average_heartrate: 162.5,
      average_speed: 3.378,
    }

    const mapped = mapStravaActivity(raw)
    expect(mapped).toEqual({
      run_id: 21130074009,
      name: 'Morning Trail Run',
      distance: 10540.5,
      moving_time: 3120,
      elapsed_time: 3250,
      type: 'Run',
      subtype: 'TrailRun',
      start_date: '2026-11-26T07:38:07Z',
      start_date_local: '2026-11-26T15:38:07',
      location_country: 'Japan',
      summary_polyline: '_p~iF~ps|U_ulLnnqC',
      average_heartrate: 162.5,
      average_speed: 3.378,
      elevation_gain: 185.4,
    })
  })

  it('applies Boxing override for Workout/WeightTraining names containing boxing or 拳击', () => {
    const boxingEn = mapStravaActivity({
      id: 1,
      name: 'Evening Boxing Session',
      distance: 0,
      moving_time: 1800,
      type: 'Workout',
      sport_type: 'Workout',
      start_date: '2025-03-01T10:00:00Z',
      start_date_local: '2025-03-01T18:00:00Z',
      map: { summary_polyline: '' },
    })
    const boxingZh = mapStravaActivity({
      id: 2,
      name: '拳击训练',
      distance: 0,
      moving_time: 1800,
      type: 'WeightTraining',
      sport_type: 'WeightTraining',
      start_date: '2025-03-02T10:00:00Z',
      start_date_local: '2025-03-02T18:00:00Z',
    })
    const boxingDayRun = mapStravaActivity({
      id: 3,
      name: 'Boxing Day 10K Run',
      distance: 10000,
      moving_time: 3000,
      type: 'Run',
      sport_type: 'Run',
      start_date: '2025-12-26T00:00:00Z',
      start_date_local: '2025-12-26T08:00:00Z',
    })

    expect(boxingEn.type).toBe('Boxing')
    expect(boxingEn.summary_polyline).toBeNull()
    expect(boxingEn.average_heartrate).toBeNull()
    expect(boxingZh.type).toBe('Boxing')
    expect(boxingDayRun.type).toBe('Run')
  })

  it('geocodes missing or generic China locations with deduplication and skips known non-China locations', async () => {
    const reverseGeocode = vi.fn(async (lat: number) => (lat > 35 ? '中国' : ''))
    const geocoder: ReverseGeocoder = { reverseGeocode }

    const activities: StravaSummaryActivity[] = [
      {
        id: 1,
        name: 'Beijing Run 1',
        distance: 5000,
        moving_time: 1500,
        type: 'Run',
        start_date: '2025-03-01T00:00:00Z',
        start_date_local: '2025-03-01T08:00:00Z',
        location_country: 'China',
        start_latlng: [39.94401, 116.48201],
      },
      {
        id: 2,
        name: 'Beijing Run 2 (same rounded coord)',
        distance: 5000,
        moving_time: 1500,
        type: 'Run',
        start_date: '2025-03-02T00:00:00Z',
        start_date_local: '2025-03-02T08:00:00Z',
        location_country: null,
        start_latlng: [39.94404, 116.48204],
      },
      {
        id: 3,
        name: 'Tokyo Run (already geocoded)',
        distance: 5000,
        moving_time: 1500,
        type: 'Run',
        start_date: '2025-03-03T00:00:00Z',
        start_date_local: '2025-03-03T09:00:00Z',
        location_country: 'Japan',
        start_latlng: [35.6762, 139.6503],
      },
      {
        id: 4,
        name: 'Indoor Workout (no GPS)',
        distance: 0,
        moving_time: 1200,
        type: 'Workout',
        start_date: '2025-03-04T00:00:00Z',
        start_date_local: '2025-03-04T08:00:00Z',
        location_country: '',
        start_latlng: [],
      },
    ]

    const mapped = await mapStravaActivities(activities, { geocoder, logger: silentLogger })

    expect(reverseGeocode).toHaveBeenCalledTimes(1)
    expect(mapped[0].location_country).toBe('中国')
    expect(mapped[1].location_country).toBe('中国')
    expect(mapped[2].location_country).toBe('Japan')
    expect(mapped[3].location_country).toBe('')
  })
})

describe('convertStreamsToFlybyPoints', () => {
  it('aligns outdoor GPS streams on time series and computes rounded lat/lng, pace, and clamped HR', () => {
    const streams: StravaStreamsMap = {
      time: { data: [0, 10, 20, 30] },
      latlng: {
        data: [
          [39.944123456, 116.482987654],
          [39.9445, 116.4831],
          [39.9449, 116.4835],
          [39.9453, 116.4839],
        ],
      },
      altitude: { data: [40.8, 41.2, null] }, // shorter -> padded with null
      velocity_smooth: { data: [3.3333, 3.3333333, 0.2, 25] }, // t=0->0, 5.0 min/km, 83.33->0 (>30), 0.67->0 (<1)
      heartrate: { data: [135.7, 152.2, 260, -5] }, // 260 & -5 out of [0,255] -> null
      distance: { data: [0, 33.9, 66.4, 100.1, 130.0] }, // longer -> truncated
      cadence: { data: [84.9, 86.1] },
      watts: { data: [220.4, null, 240.9] },
    }

    const points = convertStreamsToFlybyPoints(100001, streams)

    expect(points).toEqual([
      {
        activity_id: 100001,
        time_offset: 0,
        lat: 39.944123,
        lng: 116.482988,
        alt: 40,
        pace: 0,
        hr: 135,
        distance: 0,
        cadence: 84,
        watts: 220,
      },
      {
        activity_id: 100001,
        time_offset: 10,
        lat: 39.9445,
        lng: 116.4831,
        alt: 41,
        pace: 5,
        hr: 152,
        distance: 33,
        cadence: 86,
        watts: null,
      },
      {
        activity_id: 100001,
        time_offset: 20,
        lat: 39.9449,
        lng: 116.4835,
        alt: null,
        pace: 0,
        hr: null,
        distance: 66,
        cadence: null,
        watts: 240,
      },
      {
        activity_id: 100001,
        time_offset: 30,
        lat: 39.9453,
        lng: 116.4839,
        alt: null,
        pace: 0,
        hr: null,
        distance: 100,
        cadence: null,
        watts: null,
      },
    ])
  })

  it('truncates to min(time, latlng) when time and latlng lengths mismatch', () => {
    const points = convertStreamsToFlybyPoints(200, {
      time: { data: [0, 5, 10, 15] },
      latlng: { data: [[39.9, 116.4], [39.91, 116.41]] },
      heartrate: { data: [120, 130, 140, 150] },
    })

    expect(points).toHaveLength(2)
    expect(points.map(p => p.time_offset)).toEqual([0, 5])
    expect(points.map(p => p.hr)).toEqual([120, 130])
  })

  it('supports indoor activities without latlng when another meaningful stream has valid data', () => {
    const points = convertStreamsToFlybyPoints(300, {
      time: { data: [0, 60] },
      heartrate: { data: [115, 142] },
    })

    expect(points).toEqual([
      {
        activity_id: 300,
        time_offset: 0,
        lat: null,
        lng: null,
        alt: null,
        pace: 0,
        hr: 115,
        distance: null,
        cadence: null,
        watts: null,
      },
      {
        activity_id: 300,
        time_offset: 60,
        lat: null,
        lng: null,
        alt: null,
        pace: 0,
        hr: 142,
        distance: null,
        cadence: null,
        watts: null,
      },
    ])
  })

  it('returns empty array when time stream is missing or no non-time stream contains valid data', () => {
    expect(convertStreamsToFlybyPoints(400, {})).toEqual([])
    expect(convertStreamsToFlybyPoints(400, { time: { data: [0, 10, 20] } })).toEqual([])
    expect(
      convertStreamsToFlybyPoints(400, {
        time: { data: [0, 10] },
        heartrate: { data: [null, null] },
        altitude: { data: [] },
      }),
    ).toEqual([])
  })
})

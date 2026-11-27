export const BASE_TIMEZONE = 'Asia/Shanghai' as const
export const UTC_TIMEZONE = 'UTC' as const

export const STRAVA_GARMIN_TYPE_DICT: Readonly<Record<string, string>> = {
  Hike: 'hiking',
  Run: 'running',
  EBikeRide: 'cycling',
  Walk: 'walking',
  Swim: 'swimming',
}

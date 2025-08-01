// const
const MAPBOX_TOKEN
  // For security reasons, please avoid using the default public token provided by Mapbox as much as possible.
  // Instead, manually add a new token and apply URL restrictions.
  // (please refer to https://github.com/yihong0618/running_page/issues/643#issuecomment-2042668580)
  = 'pk.eyJ1IjoiY215a2ZlaSIsImEiOiJjbDQ5NTZ6aDAwMHkwM2psa3FiemNqMmw1In0.OfV3cpXB1TK6wHOaoWOiIQ'
const MUNICIPALITY_CITIES_ARR = [
  '北京市',
  '上海市',
  '天津市',
  '重庆市',
  '香港特别行政区',
  '澳门特别行政区',
]
const MAP_LAYER_LIST = [
  'road-label',
  'waterway-label',
  'natural-line-label',
  'natural-point-label',
  'water-line-label',
  'water-point-label',
  'poi-label',
  'airport-label',
  'settlement-subdivision-label',
  'settlement-label',
  'state-label',
  'country-label',
]

const USE_GOOGLE_ANALYTICS = true
const GOOGLE_ANALYTICS_TRACKING_ID = 'G-W2EVGZBMZR'

const DISABLE_MAP = false
const DISABLE_CHART = true
const DISABLE_FLYBY = false
// styling: set to `true` if you want dash-line route
const USE_DASH_LINE = false
// styling: route line opacity: [0, 1]
const LINE_OPACITY = 0.6
// styling: map height
const MAP_HEIGHT = 500
// set to `false` if you want to hide the road label characters
const ROAD_LABEL_DISPLAY = false
// update for now 2024/11/17 the privacy mode is true
// set to `true` if you want to display only the routes without showing the map.
const PRIVACY_MODE = false
// update for now 2024/11/17 the lights on default is false
// set to `false` if you want to make light off as default, only effect when `PRIVACY_MODE` = false
const LIGHTS_ON = true
// richer title for the activity types (like garmin style)
const RICH_TITLE = true

// IF you outside China please make sure IS_CHINESE = false
const IS_CHINESE = true
const USE_ANIMATION_FOR_GRID = false
function ENGLISH_INFO_MESSAGE(yearLength: number, year: string): string {
  return `Running Journey with ${yearLength} Years, the table shows year ${year} data`
}

// not support English for now
const CHINESE_LOCATION_INFO_MESSAGE_FIRST
  = '我跑过了一些地方，希望随着时间推移，地图点亮的地方越来越多'
const CHINESE_LOCATION_INFO_MESSAGE_SECOND = '不要停下来，不要停下奔跑的脚步'

const INFO_MESSAGE = ENGLISH_INFO_MESSAGE
const FULL_MARATHON_RUN_TITLE = 'Full Marathon'
const HALF_MARATHON_RUN_TITLE = 'Half Marathon'
const MORNING_RUN_TITLE = 'Morning Run'
const MIDDAY_RUN_TITLE = 'Midday Run'
const AFTERNOON_RUN_TITLE = 'Afternoon Run'
const EVENING_RUN_TITLE = 'Evening Run'
const NIGHT_RUN_TITLE = 'Night Run'
const RUN_GENERIC_TITLE = 'Run'
const RUN_TRAIL_TITLE = 'Trail Run'
const RUN_TREADMILL_TITLE = 'Treadmill Run'
const HIKING_TITLE = 'Hiking'
const CYCLING_TITLE = 'Cycling'
const SKIING_TITLE = 'Skiing'
const WALKING_TITLE = 'Walking'

const MORNING_CYCLING_TITLE = 'Morning Ride'
const MIDDAY_CYCLING_TITLE = 'Midday Ride'
const AFTERNOON_CYCLING_TITLE = 'Afternoon Ride'
const EVENING_CYCLING_TITLE = 'Evening Ride'
const NIGHT_CYCLING_TITLE = 'Night Ride'

const ACTIVITY_TYPES = {
  RUN_GENERIC_TITLE,
  RUN_TRAIL_TITLE,
  RUN_TREADMILL_TITLE,
  HIKING_TITLE,
  CYCLING_TITLE,
  SKIING_TITLE,
  WALKING_TITLE,
}

const RUN_TITLES = {
  FULL_MARATHON_RUN_TITLE,
  HALF_MARATHON_RUN_TITLE,
  MORNING_RUN_TITLE,
  MIDDAY_RUN_TITLE,
  AFTERNOON_RUN_TITLE,
  EVENING_RUN_TITLE,
  NIGHT_RUN_TITLE,
}

const CYCLING_TITLES = {
  MORNING_CYCLING_TITLE,
  MIDDAY_CYCLING_TITLE,
  AFTERNOON_CYCLING_TITLE,
  EVENING_CYCLING_TITLE,
  NIGHT_CYCLING_TITLE,
}

export {
  ACTIVITY_TYPES,
  CHINESE_LOCATION_INFO_MESSAGE_FIRST,
  CHINESE_LOCATION_INFO_MESSAGE_SECOND,
  CYCLING_TITLES,
  DISABLE_CHART,
  DISABLE_FLYBY,
  DISABLE_MAP,
  GOOGLE_ANALYTICS_TRACKING_ID,
  INFO_MESSAGE,
  IS_CHINESE,
  LIGHTS_ON,
  LINE_OPACITY,
  MAP_HEIGHT,
  MAP_LAYER_LIST,
  MAPBOX_TOKEN,
  MUNICIPALITY_CITIES_ARR,
  PRIVACY_MODE,
  RICH_TITLE,
  ROAD_LABEL_DISPLAY,
  RUN_TITLES,
  USE_ANIMATION_FOR_GRID,
  USE_DASH_LINE,
  USE_GOOGLE_ANALYTICS,
}

const dark_vanilla = '#E4D4DC'
export const COUNTRY_FILL_COLOR = dark_vanilla

// If your map has an offset please change this line
// issues #92 and #198
export const NEED_FIX_MAP = false

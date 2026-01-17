// MapLibre 免费地图样式 (OpenFreeMap)
const MAPLIBRE_LIGHT_STYLE = 'https://tiles.openfreemap.org/styles/liberty'
const MAPLIBRE_DARK_STYLE = 'https://tiles.openfreemap.org/styles/dark'
const MUNICIPALITY_CITIES_ARR = [
  '北京市',
  '上海市',
  '天津市',
  '重庆市',
  '香港特别行政区',
  '澳门特别行政区',
]
// OpenFreeMap 图层名称 - 所有 symbol 类型的文字标签
// 注意: liberty 和 dark 样式的图层名称不同，需要同时包含
const MAP_LAYER_LIST = [
  // === Liberty 样式 ===
  // 水域标签
  'waterway_line_label',
  'water_name_point_label',
  'water_name_line_label',
  // 道路名称
  'highway-name-path',
  'highway-name-minor',
  'highway-name-major',
  // 道路标识
  'highway-shield-non-us',
  'highway-shield-us-interstate',
  'road_shield_us',
  // POI 兴趣点标签
  'poi_r1',
  'poi_r7',
  'poi_r20',
  'poi_transit',
  'airport',
  // 地点标签
  'label_other',
  'label_village',
  'label_town',
  'label_state',
  'label_city',
  'label_city_capital',
  // 国家标签
  'label_country_3',
  'label_country_2',
  'label_country_1',

  // === Dark 样式 ===
  // 水域标签
  'water_name',
  // 道路名称
  'highway_name_other',
  'highway_name_motorway',
  // 地点标签
  'place_other',
  'place_suburb',
  'place_village',
  'place_town',
  'place_city',
  'place_city_large',
  'place_state',
  // 国家标签
  'place_country_other',
  'place_country_minor',
  'place_country_major',
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
// styling: map height (desktop)
const MAP_HEIGHT = 600
// styling: map height (mobile)
const MAP_HEIGHT_MOBILE = 400
// styling: map aspect ratio (width:height) - 16:9 is common for landscape maps
const MAP_ASPECT_RATIO = 16 / 10
// set to `false` if you want to hide the road label characters
const ROAD_LABEL_DISPLAY = false
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
  LINE_OPACITY,
  MAP_ASPECT_RATIO,
  MAP_HEIGHT,
  MAP_HEIGHT_MOBILE,
  MAP_LAYER_LIST,
  MAPLIBRE_DARK_STYLE,
  MAPLIBRE_LIGHT_STYLE,
  MUNICIPALITY_CITIES_ARR,
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

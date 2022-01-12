// const
// https://account.mapbox.com/access-tokens
const MAPBOX_TOKEN =
  'pk.eyJ1IjoiY215a2ZlaSIsImEiOiJja2d0NWpmbHQwdTU3MnltZnoxdXRuZGhkIn0.xWYvjezVwGkzWJ3NbUYRLQ';


const MUNICIPALITY_CITIES_ARR = [
  '北京市',
  '上海市',
  '天津市',
  '重庆市',
  '香港特别行政区',
  '澳门特别行政区'
];

// IF you outside China please make sure IS_CHINESE = false
const IS_CHINESE = true;
const USE_ANIMATION_FOR_GRID = false;

const CHINESE_INFO_MESSAGE = (yearLength, year) =>
  `我用 App 记录自己跑步 ${yearLength} 年了，下面列表展示的是 ${year} 的数据`;

const ENGLISH_INFO_MESSAGE = (yearLength, year) =>
  `Running Journey with ${yearLength} Years, the table shows year ${year} data`;

const INFO_MESSAGE = IS_CHINESE ? ENGLISH_INFO_MESSAGE : ENGLISH_INFO_MESSAGE;

const FULL_MARATHON_RUN_TITLE = IS_CHINESE ? 'Full Marathon' : 'Full Marathon';
const HALF_MARATHON_RUN_TITLE = IS_CHINESE ? 'Half Marathon' : 'Half Marathon';
const MORNING_RUN_TITLE = IS_CHINESE ? 'Morning Run' : 'Morning Run';
const LUNCH_RUN_TITLE = IS_CHINESE ? 'Lunch Run' : 'Lunch Run';
const AFTERNOON_RUN_TITLE = IS_CHINESE ? 'Afternoon Run' : 'Afternoon Run';
const EVENING_RUN_TITLE = IS_CHINESE ? 'Evening Run' : 'Evening Run';
const NIGHT_RUN_TITLE = IS_CHINESE ? 'Night Run' : 'Night Run';

const RUN_TITLES = {
  FULL_MARATHON_RUN_TITLE,
  HALF_MARATHON_RUN_TITLE,
  MORNING_RUN_TITLE,
  LUNCH_RUN_TITLE,
  AFTERNOON_RUN_TITLE,
  EVENING_RUN_TITLE,
  NIGHT_RUN_TITLE
};

export {
  MAPBOX_TOKEN,
  MUNICIPALITY_CITIES_ARR,
  IS_CHINESE,
  INFO_MESSAGE,
  RUN_TITLES
};

const nike = 'rgb(224,237,94)';
export const MAIN_COLOR = nike;
export const PROVINCE_FILL_COLOR = '#47b8e0';

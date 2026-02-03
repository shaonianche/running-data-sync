import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_TYPES,
  CYCLING_TITLES,
  RUN_TITLES,
  MUNICIPALITY_CITIES_ARR,
  MAP_HEIGHT,
  MAP_HEIGHT_MOBILE,
  LINE_OPACITY,
  IS_CHINESE,
  MAPLIBRE_LIGHT_STYLE,
  MAPLIBRE_DARK_STYLE,
} from './const'

describe('Constants', () => {
  describe('ACTIVITY_TYPES', () => {
    it('should have all required activity types', () => {
      expect(ACTIVITY_TYPES.RUN_GENERIC_TITLE).toBeDefined()
      expect(ACTIVITY_TYPES.RUN_TRAIL_TITLE).toBeDefined()
      expect(ACTIVITY_TYPES.RUN_TREADMILL_TITLE).toBeDefined()
      expect(ACTIVITY_TYPES.HIKING_TITLE).toBeDefined()
      expect(ACTIVITY_TYPES.CYCLING_TITLE).toBeDefined()
      expect(ACTIVITY_TYPES.WALKING_TITLE).toBeDefined()
    })

    it('should have correct values', () => {
      expect(ACTIVITY_TYPES.RUN_GENERIC_TITLE).toBe('Run')
      expect(ACTIVITY_TYPES.HIKING_TITLE).toBe('Hiking')
      expect(ACTIVITY_TYPES.CYCLING_TITLE).toBe('Cycling')
    })
  })

  describe('RUN_TITLES', () => {
    it('should have all run title variants', () => {
      expect(RUN_TITLES.MORNING_RUN_TITLE).toBeDefined()
      expect(RUN_TITLES.MIDDAY_RUN_TITLE).toBeDefined()
      expect(RUN_TITLES.AFTERNOON_RUN_TITLE).toBeDefined()
      expect(RUN_TITLES.EVENING_RUN_TITLE).toBeDefined()
      expect(RUN_TITLES.NIGHT_RUN_TITLE).toBeDefined()
      expect(RUN_TITLES.HALF_MARATHON_RUN_TITLE).toBeDefined()
      expect(RUN_TITLES.FULL_MARATHON_RUN_TITLE).toBeDefined()
    })
  })

  describe('CYCLING_TITLES', () => {
    it('should have all cycling title variants', () => {
      expect(CYCLING_TITLES.MORNING_CYCLING_TITLE).toBeDefined()
      expect(CYCLING_TITLES.MIDDAY_CYCLING_TITLE).toBeDefined()
      expect(CYCLING_TITLES.AFTERNOON_CYCLING_TITLE).toBeDefined()
      expect(CYCLING_TITLES.EVENING_CYCLING_TITLE).toBeDefined()
      expect(CYCLING_TITLES.NIGHT_CYCLING_TITLE).toBeDefined()
    })
  })

  describe('MUNICIPALITY_CITIES_ARR', () => {
    it('should contain Chinese municipality cities', () => {
      expect(MUNICIPALITY_CITIES_ARR).toContain('北京市')
      expect(MUNICIPALITY_CITIES_ARR).toContain('上海市')
      expect(MUNICIPALITY_CITIES_ARR).toContain('天津市')
      expect(MUNICIPALITY_CITIES_ARR).toContain('重庆市')
    })

    it('should have correct length', () => {
      expect(MUNICIPALITY_CITIES_ARR.length).toBeGreaterThanOrEqual(4)
    })
  })

  describe('Map Configuration', () => {
    it('should have valid map height values', () => {
      expect(MAP_HEIGHT).toBeGreaterThan(0)
      expect(MAP_HEIGHT_MOBILE).toBeGreaterThan(0)
      expect(MAP_HEIGHT).toBeGreaterThan(MAP_HEIGHT_MOBILE)
    })

    it('should have valid line opacity', () => {
      expect(LINE_OPACITY).toBeGreaterThanOrEqual(0)
      expect(LINE_OPACITY).toBeLessThanOrEqual(1)
    })

    it('should have valid map style URLs', () => {
      expect(MAPLIBRE_LIGHT_STYLE).toMatch(/^https?:\/\//)
      expect(MAPLIBRE_DARK_STYLE).toMatch(/^https?:\/\//)
    })
  })

  describe('Locale Settings', () => {
    it('should have IS_CHINESE defined', () => {
      expect(typeof IS_CHINESE).toBe('boolean')
    })
  })
})

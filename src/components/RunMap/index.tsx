import type { FeatureCollection } from 'geojson'
import type { Map as MaplibreMap } from 'maplibre-gl'
import type {
  MapRef,
} from 'react-map-gl/maplibre'
import type { RPGeometry } from '@/static/run_countries'
import type { Coordinate, IViewState } from '@/utils/utils'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Map, {
  FullscreenControl,
  Layer,
  NavigationControl,
  Source,
} from 'react-map-gl/maplibre'
import activitiesData from '@/hooks/useActivities'
import {
  DISABLE_CHART,
  DISABLE_MAP,
  IS_CHINESE,
  LINE_OPACITY,
  MAP_HEIGHT,
  MAP_HEIGHT_MOBILE,
  MAP_LAYER_LIST,
  MAPLIBRE_DARK_STYLE,
  MAPLIBRE_LIGHT_STYLE,
  ROAD_LABEL_DISPLAY,
  USE_DASH_LINE,
} from '@/utils/const'
import { geoJsonForMap, getMainColor } from '@/utils/utils'
import ActivityChart from './ActivityChart'
import MapErrorBoundary from './MapErrorBoundary'
import MapFallback from './MapFallback'
import RunMapButtons from './RunMapButtons'
import RunMarker from './RunMarker'
import 'maplibre-gl/dist/maplibre-gl.css'
import './maplibre.css'

const PROVINCE_FILL_COLOR = getMainColor()
const COUNTRY_FILL_COLOR = getMainColor()

// 隐藏地名标签图层
function hideMapLabels(map: MaplibreMap) {
  if (!ROAD_LABEL_DISPLAY) {
    MAP_LAYER_LIST.forEach((layerId) => {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', 'none')
      }
    })
  }
}

interface IRunMapProps {
  title: string
  viewState: IViewState
  setViewState: (_viewState: IViewState) => void
  changeYear: (_year: string) => void
  geoData: FeatureCollection<RPGeometry>
  thisYear: string
}

function RunMap({
  viewState,
  setViewState,
  changeYear,
  geoData,
  thisYear,
}: IRunMapProps) {
  const { countries, provinces } = activitiesData
  const mapRef = useRef<MapRef | null>(null)
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const savedTheme = localStorage.getItem('theme')
    if (savedTheme === 'dark')
      return true
    if (savedTheme === 'light')
      return false
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  const [isMapVisible, setIsMapVisible] = useState(true)
  const [isSmallScreen, setIsSmallScreen] = useState(() => window.matchMedia('(max-width: 768px)').matches)
  const hasAppliedMobileDefaultZoom = useRef(false)
  const lastFittedBoundsKey = useRef<string | null>(null)
  const hasAppliedNoGpsMobileDefault = useRef(false)
  const [mapError, setMapError] = useState<Error | null>(null)

  useEffect(() => {
    const updateTheme = () => {
      const savedTheme = localStorage.getItem('theme')
      if (savedTheme === 'dark') {
        setIsDarkMode(true)
      }
      else if (savedTheme === 'light') {
        setIsDarkMode(false)
      }
      else {
        setIsDarkMode(window.matchMedia('(prefers-color-scheme: dark)').matches)
      }
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', updateTheme)
    const observer = new MutationObserver(updateTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    window.addEventListener('storage', updateTheme)
    return () => {
      mq.removeEventListener('change', updateTheme)
      observer.disconnect()
      window.removeEventListener('storage', updateTheme)
    }
  }, [])

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const update = () => setIsSmallScreen(mq.matches)
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // Ensure a comfortable default zoom on mobile to avoid overly-zoomed-in views
  useEffect(() => {
    if (isSmallScreen && !hasAppliedMobileDefaultZoom.current) {
      const currentZoom = viewState.zoom ?? 0
      if (currentZoom === 0 || currentZoom > 4) {
        setViewState({ ...viewState, zoom: 3 })
      }
      hasAppliedMobileDefaultZoom.current = true
    }
  }, [isSmallScreen, setViewState, viewState])

  // Detect if there are any line features (GPS tracks) in the provided geoData
  const hasRunLines = useMemo(() => {
    try {
      return geoData.features?.some((f: any) => {
        const t = f?.geometry?.type
        return t === 'LineString' || t === 'MultiLineString'
      }) ?? false
    }
    catch {
      return false
    }
  }, [geoData])

  // For activities without GPS on mobile, set a sane global default center/zoom once
  useEffect(() => {
    if (!isSmallScreen || hasRunLines || hasAppliedNoGpsMobileDefault.current)
      return
    const worldBounds = [
      [-180, -60],
      [180, 85],
    ] as [[number, number], [number, number]]
    const map = mapRef.current?.getMap()
    if (map) {
      try {
        map.fitBounds(worldBounds, { padding: 16, duration: 0, maxZoom: 1.2 })
        hasAppliedNoGpsMobileDefault.current = true
        return
      }
      catch {}
    }
    const defaultCenter = IS_CHINESE ? { longitude: 104.0, latitude: 18.0 } : { longitude: 0, latitude: 12 }
    const next = { ...viewState, ...defaultCenter, zoom: 1, bearing: 0, pitch: 0 }
    setViewState(next)
    hasAppliedNoGpsMobileDefault.current = true
  }, [isSmallScreen, hasRunLines, viewState, setViewState])

  // Listen for global year change from top mobile selector
  useEffect(() => {
    const onChangeYear = (e: any) => {
      const y = e?.detail?.year
      if (y)
        changeYear(y)
    }
    window.addEventListener('app:changeYear' as any, onChangeYear)
    return () => window.removeEventListener('app:changeYear' as any, onChangeYear)
  }, [changeYear])

  const mapRefCallback = useCallback(
    (ref: MapRef) => {
      if (ref !== null && mapRef.current !== ref) {
        mapRef.current = ref
        const map = ref.getMap() as MaplibreMap
        // 监听样式加载并隐藏标签（包括初始化和主题切换）
        map.on('styledata', () => {
          // 使用 setTimeout 确保样式和图层完全加载
          setTimeout(() => {
            hideMapLabels(map)
          }, 100)
        })
      }
    },
    [],
  )

  const isBigMap = (viewState.zoom ?? 0) <= 3

  const filterProvinces = useMemo(() => ['in', 'name', ...provinces], [provinces])
  const filterCountries = useMemo(() => ['in', 'name', ...countries], [countries])

  const composedGeoData = useMemo(() => {
    if (isBigMap && IS_CHINESE) {
      return {
        type: 'FeatureCollection' as const,
        features: [...geoData.features, ...geoJsonForMap().features],
      }
    }
    return geoData
  }, [geoData, isBigMap])

  const isSingleRun
    = geoData.features.length === 1 && geoData.features[0].geometry.coordinates.length
  let startLon = 0
  let startLat = 0
  let endLon = 0
  let endLat = 0
  if (isSingleRun) {
    const points = geoData.features[0].geometry.coordinates as Coordinate[];
    [startLon, startLat] = points[0];
    [endLon, endLat] = points[points.length - 1]
  }
  // Normalize GeoJSON coordinates (LineString | MultiLineString | MultiPolygon) to a flat number[][] for marker
  const lineCoordinates: number[][] = useMemo(() => {
    try {
      const coordsAny: any = geoData.features[0]?.geometry?.coordinates
      return Array.isArray(coordsAny?.[0]?.[0]) ? (coordsAny[0] as number[][]) : (coordsAny as number[][])
    }
    catch {
      return []
    }
  }, [geoData])
  const dash = USE_DASH_LINE && !isSingleRun && !isBigMap ? [2, 2] : [2, 0]
  const onMove = React.useCallback(
    ({ viewState }: { viewState: IViewState }) => {
      setViewState(viewState)
    },
    [setViewState],
  )
  const mapHeight = isSmallScreen ? MAP_HEIGHT_MOBILE : MAP_HEIGHT
  const style: React.CSSProperties = {
    width: '100%',
    height: mapHeight,
  }
  const fullscreenButton: React.CSSProperties = {
    position: 'absolute',
    marginTop: '29.2px',
    right: '0px',
    opacity: 0.3,
  }

  useEffect(() => {
    const handleFullscreenChange = () => {
      if (mapRef.current) {
        mapRef.current.getMap().resize()
      }
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
    }
  }, [])

  // When a single run is selected, fit bounds with optimal padding and zoom
  useEffect(() => {
    if (!mapRef.current || !isSingleRun || lineCoordinates.length === 0)
      return
    const longitudes = lineCoordinates.map(c => c[0])
    const latitudes = lineCoordinates.map(c => c[1])
    const minLon = Math.min(...longitudes)
    const maxLon = Math.max(...longitudes)
    const minLat = Math.min(...latitudes)
    const maxLat = Math.max(...latitudes)
    const boundsKey = `${minLon.toFixed(5)}:${minLat.toFixed(5)}:${maxLon.toFixed(5)}:${maxLat.toFixed(5)}:${isSmallScreen}`
    if (lastFittedBoundsKey.current === boundsKey)
      return
    lastFittedBoundsKey.current = boundsKey
    const map = mapRef.current.getMap()
    try {
      // Use percentage-based padding for consistent look across screen sizes
      const padding = isSmallScreen
        ? { top: 30, bottom: 30, left: 20, right: 20 }
        : { top: 60, bottom: 60, left: 60, right: 60 }
      map.fitBounds(
        [
          [minLon, minLat],
          [maxLon, maxLat],
        ],
        {
          padding,
          maxZoom: isSmallScreen ? 14 : 15,
          duration: 300,
        },
      )
    }
    catch {}
  }, [isSingleRun, isSmallScreen, lineCoordinates])

  return (
    <div>
      {!isSmallScreen && (
        <RunMapButtons
          changeYear={changeYear}
          thisYear={thisYear}
          isMapVisible={isMapVisible}
          onToggleMapVisible={() => setIsMapVisible(v => !v)}
          showMapToggle={true}
        />
      )}
      {!DISABLE_CHART
        ? <ActivityChart thisYear={thisYear} />
        : (
            !DISABLE_MAP && isMapVisible && (
              <div style={{ position: 'relative' }}>
                {mapError
                  ? (
                      <MapFallback error={mapError} />
                    )
                  : (
                      <MapErrorBoundary>
                        <Map
                          {...viewState}
                          onMove={onMove}
                          style={style}
                          mapStyle={isDarkMode ? MAPLIBRE_DARK_STYLE : MAPLIBRE_LIGHT_STYLE}
                          ref={mapRefCallback}
                          doubleClickZoom={!isSmallScreen}
                          scrollZoom={!isSmallScreen}
                          keyboard={!isSmallScreen}
                          touchZoomRotate={!isSmallScreen}
                          touchPitch={!isSmallScreen}
                          dragRotate={!isSmallScreen}
                          dragPan={!isSmallScreen}
                          pitchWithRotate={!isSmallScreen}
                          minZoom={isSmallScreen ? 0.25 : 0}
                          maxZoom={isSmallScreen ? 16 : 22}
                          onError={(e) => {
                            console.error('Map error:', e)
                            setMapError(e.error)
                          }}
                        >
                          <Source id="data" type="geojson" data={composedGeoData}>
                            <Layer
                              id="province"
                              type="fill"
                              paint={{
                                'fill-color': PROVINCE_FILL_COLOR,
                              }}
                              filter={filterProvinces}
                            />
                            <Layer
                              id="countries"
                              type="fill"
                              paint={{
                                'fill-color': COUNTRY_FILL_COLOR,
                                'fill-opacity': ['case', ['==', ['get', 'name'], '中国'], 0.1, 0.5],
                              }}
                              filter={filterCountries}
                            />
                            <Layer
                              id="runs2"
                              type="line"
                              paint={{
                                'line-color': ['coalesce', ['get', 'color'], ['literal', getMainColor()]],
                                'line-width': isBigMap ? 4 : 5,
                                'line-dasharray': dash,
                                'line-opacity': LINE_OPACITY,
                                'line-blur': 1,
                              }}
                              layout={{
                                'line-join': 'round',
                                'line-cap': 'round',
                              }}
                            />
                          </Source>
                          {isSingleRun && (
                            <RunMarker
                              startLat={startLat}
                              startLon={startLon}
                              endLat={endLat}
                              endLon={endLon}
                              coordinates={lineCoordinates}
                            />
                          )}
                          <FullscreenControl style={fullscreenButton} />
                          <NavigationControl
                            showCompass={false}
                            position="bottom-right"
                            style={{ opacity: 0.3 }}
                          />
                        </Map>
                      </MapErrorBoundary>
                    )}
              </div>
            )
          )}
    </div>
  )
}

export default RunMap

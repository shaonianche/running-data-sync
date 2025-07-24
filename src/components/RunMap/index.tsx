import type { FeatureCollection } from 'geojson'
import type {
  MapRef,
} from 'react-map-gl'
import type { MapInstance } from 'react-map-gl/src/types/lib'
import type { RPGeometry } from '@/static/run_countries'
import type { Coordinate, IViewState } from '@/utils/utils'
import MapboxLanguage from '@mapbox/mapbox-gl-language'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Map, {
  FullscreenControl,
  Layer,
  NavigationControl,
  Source,
} from 'react-map-gl'
import LightsControl from '@/components/RunMap/LightsControl'
import getActivities from '@/hooks/useActivities'
import {
  DISABLE_CHART,
  DISABLE_MAP,
  IS_CHINESE,
  LIGHTS_ON,
  LINE_OPACITY,
  MAP_HEIGHT,
  MAP_LAYER_LIST,
  MAPBOX_TOKEN,
  PRIVACY_MODE,
  ROAD_LABEL_DISPLAY,
  USE_DASH_LINE,
} from '@/utils/const'
import { geoJsonForMap, getMainColor } from '@/utils/utils'
import ActivityChart from './ActivityChart'
import RunMapButtons from './RunMapButtons'
import RunMarker from './RunMarker'
import './mapbox.css'

const PROVINCE_FILL_COLOR = getMainColor()
const COUNTRY_FILL_COLOR = getMainColor()

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
  const { countries, provinces } = getActivities()
  const mapRef = useRef<MapRef | null>(null)
  const [lights, setLights] = useState(PRIVACY_MODE ? false : LIGHTS_ON)
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const theme = document.documentElement.getAttribute('data-theme')
    return theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches
  })
  const [isMapVisible, setIsMapVisible] = useState(true)

  useEffect(() => {
    const updateTheme = () => {
      const theme = document.documentElement.getAttribute('data-theme')
      setIsDarkMode(theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches)
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', updateTheme)
    const observer = new MutationObserver(updateTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      mq.removeEventListener('change', updateTheme)
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (mapRef.current) {
      const map = mapRef.current.getMap()
      map.setStyle(isDarkMode ? 'mapbox://styles/mapbox/dark-v10' : 'mapbox://styles/mapbox/light-v10')
    }
  }, [isDarkMode])

  const keepWhenLightsOff = useMemo(() => ['runs2'], [])
  const switchLayerVisibility = useCallback((map: MapInstance, lights: boolean) => {
    const styleJson = map.getStyle()
    if (!styleJson || !Array.isArray(styleJson.layers))
      return
    styleJson.layers.forEach((it: { id: string }) => {
      if (!keepWhenLightsOff.includes(it.id)) {
        if (lights)
          map.setLayoutProperty(it.id, 'visibility', 'visible')
        else map.setLayoutProperty(it.id, 'visibility', 'none')
      }
    })
  }, [keepWhenLightsOff])

  const mapRefCallback = useCallback(
    (ref: MapRef) => {
      if (ref !== null) {
        const map = ref.getMap() as MapInstance
        if (map && IS_CHINESE) {
          map.addControl(new MapboxLanguage({ defaultLanguage: 'zh-Hans' }) as any)
        }
        map.on('style.load', () => {
          if (!ROAD_LABEL_DISPLAY) {
            MAP_LAYER_LIST.forEach((layerId) => {
              map.removeLayer(layerId)
            })
          }
          mapRef.current = ref
          switchLayerVisibility(map, lights)
        })
      }
      if (mapRef.current) {
        const map = mapRef.current.getMap() as MapInstance
        switchLayerVisibility(map, lights)
      }
    },
    [mapRef, lights, switchLayerVisibility],
  )

  const filterProvinces = provinces.slice()
  const filterCountries = countries.slice()
  filterProvinces.unshift('in', 'name')
  filterCountries.unshift('in', 'name')

  const initGeoDataLength = geoData.features.length
  const isBigMap = (viewState.zoom ?? 0) <= 3
  if (isBigMap && IS_CHINESE) {
    if (geoData.features.length === initGeoDataLength) {
      geoData = {
        type: 'FeatureCollection',
        features: geoData.features.concat(geoJsonForMap().features),
      }
    }
  }

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
  const dash = USE_DASH_LINE && !isSingleRun && !isBigMap ? [2, 2] : [2, 0]
  const onMove = React.useCallback(
    ({ viewState }: { viewState: IViewState }) => {
      setViewState(viewState)
    },
    [setViewState],
  )
  const style: React.CSSProperties = {
    width: '100%',
    height: MAP_HEIGHT,
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

  return (
    <div>
      <RunMapButtons
        changeYear={changeYear}
        thisYear={thisYear}
        isMapVisible={isMapVisible}
        onToggleMapVisible={() => setIsMapVisible(v => !v)}
      />
      {!DISABLE_CHART
        ? <ActivityChart thisYear={thisYear} />
        : (
            !DISABLE_MAP && isMapVisible && (
              <div style={{ position: 'relative' }}>
                <Map
                  {...viewState}
                  onMove={onMove}
                  style={style}
                  mapStyle={isDarkMode ? 'mapbox://styles/mapbox/dark-v10' : 'mapbox://styles/mapbox/light-v10'}
                  ref={mapRefCallback}
                  mapboxAccessToken={MAPBOX_TOKEN}
                >
                  <Source id="data" type="geojson" data={geoData}>
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
                        'line-color': ['get', 'color'],
                        'line-width': isBigMap && lights ? 4 : 5,
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
                    />
                  )}
                  <FullscreenControl style={fullscreenButton} />
                  {!PRIVACY_MODE && <LightsControl setLights={setLights} lights={lights} />}
                  <NavigationControl
                    showCompass={false}
                    position="bottom-right"
                    style={{ opacity: 0.3 }}
                  />
                </Map>
              </div>
            )
          )}
    </div>
  )
}

export default RunMap

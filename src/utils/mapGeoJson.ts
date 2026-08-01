import type { Feature, FeatureCollection, GeoJsonProperties } from 'geojson'
import type { RPGeometry } from '@/static/run_countries'
// Deprecated package — still the lightest drop-in world.zh dataset used for province fills.
// Prefer replacing with a maintained source when one is available.
import worldGeoJson from '@surbowl/world-geo-json-zh/world.zh.json'
import { chinaGeojson } from '@/static/run_countries'

/** Country/province outlines for the big-map China heatmap view. Kept out of utils.ts so map code can lazy-load. */
export function geoJsonForMap(): FeatureCollection<RPGeometry> {
  const combinedFeatures = (worldGeoJson.features as Feature<RPGeometry, GeoJsonProperties>[]).concat(
    chinaGeojson.features as Feature<RPGeometry, GeoJsonProperties>[],
  )
  return {
    type: 'FeatureCollection',
    features: combinedFeatures as Feature<RPGeometry, GeoJsonProperties>[],
  }
}

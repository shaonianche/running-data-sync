import { Marker } from 'react-map-gl'
import styles from './style.module.css'

interface IRunMarkerProperties {
  startLon: number
  startLat: number
  endLon: number
  endLat: number
}

function RunMarker({
  startLon,
  startLat,
}: IRunMarkerProperties) {
  return (
    <>
      <Marker
        key="maker_start"
        longitude={startLon}
        latitude={startLat}
        pitchAlignment="map" // Align with the map plane for a more integrated look
      >
        <div className={styles.markerStart}>
          <img src="/images/logo.jpg" alt="Start" />
        </div>
      </Marker>
    </>
  )
}

export default RunMarker

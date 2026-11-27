import { useCallback, useEffect, useState } from 'react'
import { Marker } from 'react-map-gl/maplibre'
import { prefersReducedMotion } from '@/utils/motion'
import styles from './style.module.css'

interface IRunMarkerProperties {
  startLon: number
  startLat: number
  endLon: number
  endLat: number
  coordinates: number[][]
}

function getFinalPosition(coordinates: number[][], startLon: number, startLat: number, endLon: number, endLat: number) {
  if (coordinates?.length) {
    const last = coordinates[coordinates.length - 1]
    return { longitude: last[0], latitude: last[1] }
  }
  return { longitude: endLon ?? startLon, latitude: endLat ?? startLat }
}

function RunMarker({
  startLon,
  startLat,
  endLon,
  endLat,
  coordinates,
}: IRunMarkerProperties) {
  const reducedMotion = prefersReducedMotion()
  const finalPosition = getFinalPosition(coordinates, startLon, startLat, endLon, endLat)
  const [animatedPosition, setAnimatedPosition] = useState({ longitude: startLon, latitude: startLat })
  const [isAnimating, setIsAnimating] = useState(!reducedMotion)

  const getDistance = useCallback((point1: { longitude: number, latitude: number }, point2: { longitude: number, latitude: number }) => {
    const dx = point2.longitude - point1.longitude
    const dy = point2.latitude - point1.latitude
    return Math.sqrt(dx * dx + dy * dy)
  }, [])

  const getPositionOnPath = useCallback((percent: number) => {
    if (!coordinates?.length)
      return { longitude: startLon, latitude: startLat }

    const segments: number[] = []
    let totalLength = 0

    for (let i = 0; i < coordinates.length - 1; i++) {
      const length = getDistance({ longitude: coordinates[i][0], latitude: coordinates[i][1] }, { longitude: coordinates[i + 1][0], latitude: coordinates[i + 1][1] })
      segments.push(length)
      totalLength += length
    }

    const targetDistance = totalLength * percent

    let currentDist = 0
    for (let i = 0; i < segments.length; i++) {
      if (currentDist + segments[i] >= targetDistance) {
        const segmentProgress = (targetDistance - currentDist) / segments[i]
        return {
          longitude: coordinates[i][0] + (coordinates[i + 1][0] - coordinates[i][0]) * segmentProgress,
          latitude: coordinates[i][1] + (coordinates[i + 1][1] - coordinates[i][1]) * segmentProgress,
        }
      }
      currentDist += segments[i]
    }

    return { longitude: coordinates[coordinates.length - 1][0], latitude: coordinates[coordinates.length - 1][1] }
  }, [coordinates, startLon, startLat, getDistance])

  useEffect(() => {
    if (reducedMotion || !isAnimating || !coordinates?.length)
      return

    let animationFrameId: number | null = null
    let startTime: number | null = null
    let lastTime: number | null = null
    let currentDist = 0

    const totalLength = coordinates.slice(0, -1).reduce((acc, curr, i) => {
      return acc + getDistance(
        { longitude: curr[0], latitude: curr[1] },
        { longitude: coordinates[i + 1][0], latitude: coordinates[i + 1][1] },
      )
    }, 0)

    if (totalLength === 0)
      return

    const SPEED = 0.000002

    const animate = (timestamp: number) => {
      if (!startTime) {
        startTime = timestamp
        lastTime = timestamp
      }

      const deltaTime = timestamp - (lastTime as number)
      currentDist += deltaTime * SPEED
      lastTime = timestamp

      const progress = Math.min(currentDist / totalLength, 1)

      setAnimatedPosition(getPositionOnPath(progress))

      if (progress < 1) {
        animationFrameId = requestAnimationFrame(animate)
      }
      else {
        setIsAnimating(false)
      }
    }

    animationFrameId = requestAnimationFrame(animate)

    return () => {
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId)
      }
    }
  }, [reducedMotion, isAnimating, coordinates, getDistance, getPositionOnPath])

  const currentPosition = reducedMotion ? finalPosition : animatedPosition

  return (
    <Marker
      longitude={currentPosition.longitude}
      latitude={currentPosition.latitude}
      pitchAlignment="map"
      anchor="center"
    >
      <div className={styles.markerStart}>
        <img src="/images/marker_start.webp" alt="Current Position" />
      </div>
    </Marker>
  )
}

export default RunMarker

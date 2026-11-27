const POLYLINE_PRECISION = 1e5

function encodeSignedNumber(value: number): string {
  let shifted = value < 0 ? ~(value << 1) : value << 1
  let encoded = ''
  while (shifted >= 0x20) {
    encoded += String.fromCharCode((0x20 | (shifted & 0x1F)) + 63)
    shifted >>>= 5
  }
  encoded += String.fromCharCode(shifted + 63)
  return encoded
}

/**
 * Encode `[lat, lng]` coordinates into a Google Encoded Polyline string (1e5 precision).
 */
export function encodePolyline(coordinates: readonly (readonly [number, number])[]): string {
  if (coordinates.length === 0) {
    return ''
  }

  let result = ''
  let prevLat = 0
  let prevLng = 0

  for (const [lat, lng] of coordinates) {
    const latInt = Math.round(lat * POLYLINE_PRECISION)
    const lngInt = Math.round(lng * POLYLINE_PRECISION)
    result += encodeSignedNumber(latInt - prevLat)
    result += encodeSignedNumber(lngInt - prevLng)
    prevLat = latInt
    prevLng = lngInt
  }

  return result
}

/**
 * Decode a Google Encoded Polyline string (1e5 precision) into `[lat, lng]` coordinate pairs.
 */
export function decodePolyline(encoded: string): [number, number][] {
  const coordinates: [number, number][] = []
  let index = 0
  let lat = 0
  let lng = 0

  while (index < encoded.length) {
    let shift = 0
    let result = 0
    let byte = 0
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1F) << shift
      shift += 5
    } while (byte >= 0x20 && index < encoded.length)
    lat += (result & 1) !== 0 ? ~(result >> 1) : result >> 1

    if (index >= encoded.length) {
      break
    }

    shift = 0
    result = 0
    do {
      byte = encoded.charCodeAt(index++) - 63
      result |= (byte & 0x1F) << shift
      shift += 5
    } while (byte >= 0x20 && index < encoded.length)
    lng += (result & 1) !== 0 ? ~(result >> 1) : result >> 1

    coordinates.push([lat / POLYLINE_PRECISION, lng / POLYLINE_PRECISION])
  }

  return coordinates
}

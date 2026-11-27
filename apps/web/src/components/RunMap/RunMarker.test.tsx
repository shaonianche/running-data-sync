import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RunMarker from './RunMarker'

const markerPropsSpy = vi.fn()

vi.mock('react-map-gl/maplibre', () => ({
  Marker: (props: { longitude: number, latitude: number, children?: React.ReactNode }) => {
    markerPropsSpy(props)
    return <div data-testid="run-marker" data-lon={props.longitude} data-lat={props.latitude}>{props.children}</div>
  },
}))

function mockReducedMotion(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? matches : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

describe('runMarker reduced motion and cleanup', () => {
  const coordinates = [
    [120.0, 30.0],
    [120.1, 30.1],
    [120.2, 30.2],
  ]

  beforeEach(() => {
    markerPropsSpy.mockClear()
  })

  afterEach(() => {
    mockReducedMotion(false)
    vi.restoreAllMocks()
  })

  it('renders final position immediately without rAF when reduced motion is enabled', () => {
    mockReducedMotion(true)
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')

    const { getByTestId } = render(
      <RunMarker
        startLon={120.0}
        startLat={30.0}
        endLon={120.2}
        endLat={30.2}
        coordinates={coordinates}
      />,
    )

    expect(rafSpy).not.toHaveBeenCalled()
    expect(getByTestId('run-marker')).toHaveAttribute('data-lon', '120.2')
    expect(getByTestId('run-marker')).toHaveAttribute('data-lat', '30.2')
  })

  it('starts rAF in normal motion mode and cancels it on unmount', () => {
    mockReducedMotion(false)
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42)
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    const { getByTestId, unmount } = render(
      <RunMarker
        startLon={120.0}
        startLat={30.0}
        endLon={120.2}
        endLat={30.2}
        coordinates={coordinates}
      />,
    )

    expect(rafSpy).toHaveBeenCalledTimes(1)
    expect(getByTestId('run-marker')).toHaveAttribute('data-lon', '120')
    expect(getByTestId('run-marker')).toHaveAttribute('data-lat', '30')

    unmount()
    expect(cancelSpy).toHaveBeenCalledWith(42)
  })
})

import React from 'react'
import ReactGA from 'react-ga4'
import usePageTracking from '../hooks/usePageTracking'
import { USE_GOOGLE_ANALYTICS } from './const'

const TrackPageRoute: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  if (ReactGA.isInitialized) {
    usePageTracking()
  }
  return <>{children}</>
}

export function withOptionalGAPageTracking(element: React.ReactElement) {
  if (USE_GOOGLE_ANALYTICS) {
    return <TrackPageRoute>{element}</TrackPageRoute>
  }
  return element
}

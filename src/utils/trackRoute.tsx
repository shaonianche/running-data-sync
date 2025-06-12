import React from 'react'
import ReactGA from 'react-ga4'
import usePageTracking from '../hooks/usePageTracking'
import { USE_GOOGLE_ANALYTICS } from './const'

// eslint-disable-next-line react-refresh/only-export-components
const TrackPageRoute: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  if (ReactGA.isInitialized) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
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

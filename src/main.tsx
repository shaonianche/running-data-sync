import React from 'react'
import ReactDOM from 'react-dom/client'
import ReactGA from 'react-ga4'
import { HelmetProvider } from 'react-helmet-async'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import Index from './pages'
import NotFound from './pages/404'
import {
  GOOGLE_ANALYTICS_TRACKING_ID,
  USE_GOOGLE_ANALYTICS,
} from './utils/const'
import { withOptionalGAPageTracking } from './utils/trackRoute'
import '@/styles/index.css'

if (USE_GOOGLE_ANALYTICS) {
  ReactGA.initialize(GOOGLE_ANALYTICS_TRACKING_ID)
}

const routes = createBrowserRouter(
  [
    {
      path: '/',
      element: withOptionalGAPageTracking(<Index />),
    },
    {
      path: '*',
      element: withOptionalGAPageTracking(<NotFound />),
    },
  ],
  { basename: import.meta.env.BASE_URL },
)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HelmetProvider>
      <RouterProvider router={routes} />
    </HelmetProvider>
  </React.StrictMode>,
)

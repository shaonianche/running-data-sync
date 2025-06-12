import PropTypes from 'prop-types'
import React from 'react'
import { Helmet } from 'react-helmet-async'
import Header from '@/components/Header'
import useSiteMetadata from '@/hooks/useSiteMetadata'

function Layout({ children }: React.PropsWithChildren) {
  const { siteTitle, description, siteUrl, logo } = useSiteMetadata()

  return (
    <>
      <Helmet>
        <html lang="en" />
        <title>{siteTitle}</title>
        <meta name="description" content={description} />
        <meta name="keywords" content="running" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />

        <meta property="og:type" content="website" />
        <meta property="og:title" content={siteTitle} />
        <meta property="og:description" content={description} />
        <meta property="og:url" content={siteUrl} />
        <meta property="og:image" content={logo} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:site_name" content={siteTitle} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={siteTitle} />
        <meta name="twitter:description" content={description} />
        <meta name="twitter:image" content={logo} />

      </Helmet>
      <Header />
      <div className="max-w-7xl mx-auto mb-16 p-4 lg:flex lg:p-16">{children}</div>
    </>
  )
}

Layout.propTypes = {
  children: PropTypes.node.isRequired,
}

export default Layout

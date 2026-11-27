import React from 'react'
import { Helmet } from 'react-helmet-async'
import Header from '@/components/Header'
import getSiteMetadata from '@/hooks/useSiteMetadata'
import styles from './style.module.css'

function Layout({ children }: React.PropsWithChildren) {
  const { siteTitle, description } = getSiteMetadata()

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
      </Helmet>
      <Header />
      <div className={styles.container}>{children}</div>
    </>
  )
}

export default Layout

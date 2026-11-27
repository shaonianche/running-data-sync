import Layout from '@/components/Layout'
import getSiteMetadata from '@/hooks/useSiteMetadata'
import styles from './404.module.css'

function NotFoundPage() {
  const { siteUrl } = getSiteMetadata()
  return (
    <Layout>
      <h1 className={styles.heading}>404</h1>
      <p>This page doesn&#39;t exist.</p>
      <p className={styles.muted}>
        If you wanna more message, you could visit
        {' '}
        <a className={styles.link} href={siteUrl}>
          {siteUrl}
        </a>
      </p>
    </Layout>
  )
}

export default NotFoundPage

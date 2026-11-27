import { Link } from 'react-router-dom'
import ThemeToggle from '@/components/ThemeToggle'
import getSiteMetadata from '@/hooks/useSiteMetadata'
import styles from './style.module.css'

function Header() {
  const { logo, siteUrl, siteTitle, navLinks } = getSiteMetadata()

  return (
    <>
      <nav className={styles.nav}>
        <div className={styles.brandWrap}>
          <Link to={siteUrl} className={styles.brandLink}>
            <picture>
              <img
                className={styles.logo}
                alt="logo"
                src={logo}
                onError={(e) => {
                  e.currentTarget.onerror = null
                  e.currentTarget.src = '/images/favicon.ico'
                }}
              />
            </picture>
            <h1 className={styles.title}>
              {siteTitle}
            </h1>
          </Link>
        </div>
        <div className={styles.actions}>
          <div className={styles.links}>
            {navLinks.map(n => (
              <a
                key={n.url}
                href={n.url}
                className={styles.navLink}
              >
                {n.name}
              </a>
            ))}
          </div>
          <div className={styles.themeWrap}>
            <ThemeToggle />
          </div>
        </div>
      </nav>
    </>
  )
}

export default Header

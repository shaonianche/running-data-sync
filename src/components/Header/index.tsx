import { Link } from 'react-router-dom'
import ThemeToggle from '@/components/ThemeToggle'
import getSiteMetadata from '@/hooks/useSiteMetadata'

function Header() {
  const { logo, siteUrl, siteTitle, navLinks } = getSiteMetadata()

  return (
    <>
      <nav className="max-w-7xl mx-auto mt-4 md:mt-12 flex w-full flex-col md:flex-row items-center md:items-center justify-between px-4 md:px-6 lg:px-16 gap-4 md:gap-0">
        <div className="flex w-full md:w-auto items-center gap-3 md:gap-4">
          <Link to={siteUrl} className="flex items-center gap-3 md:gap-4">
            <picture>
              <img className="h-10 w-10 md:h-16 md:w-16 rounded-full" alt="logo" src={logo} />
            </picture>
            <h1 className="text-2xl md:text-4xl font-extrabold italic">
              {siteTitle}
            </h1>
          </Link>
        </div>
        <div className="flex w-full md:w-auto items-center justify-between md:justify-end gap-4 md:gap-6">
          <div className="flex overflow-x-auto whitespace-nowrap gap-3 md:gap-4">
            {navLinks.map(n => (
              <a
                key={n.url}
                href={n.url}
                className="text-base md:text-lg py-2"
              >
                {n.name}
              </a>
            ))}
          </div>
          <div className="shrink-0">
            <ThemeToggle />
          </div>
        </div>
      </nav>
    </>
  )
}

export default Header

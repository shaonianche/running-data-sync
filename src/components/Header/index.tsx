import { Link } from 'react-router-dom'
import ThemeToggle from '@/components/ThemeToggle'
import useSiteMetadata from '@/hooks/useSiteMetadata'

function Header() {
  const { logo, siteUrl, siteTitle, navLinks } = useSiteMetadata()

  return (
    <>
      <nav className="max-w-7xl mx-auto mt-12 flex w-full items-center justify-between pl-6 lg:px-16">
        <div className="flex items-center gap-4">
          <Link to={siteUrl} className="flex items-center gap-4">
            <picture>
              <img className="h-16 w-16 rounded-full" alt="logo" src={logo} />
            </picture>
            <h1 className="text-4xl font-extrabold italic">
              {siteTitle}
            </h1>
          </Link>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right">
            {navLinks.map((n, i) => (
              <a
                key={i}
                href={n.url}
                className="mr-3 text-lg lg:mr-4 lg:text-base"
              >
                {n.name}
              </a>
            ))}
          </div>
          <ThemeToggle />
        </div>
      </nav>
    </>
  )
}

export default Header

import { graphql, useStaticQuery } from 'gatsby'

const useSiteMetadata = () => {
  const { site } = useStaticQuery(
    graphql`
      query SiteMetaData {
        site {
          siteMetadata {
            siteTitle
            siteUrl
            logo
            description
            navLinks {
              name
              url
            }
          }
        }
      }
    `,
  )
  return site.siteMetadata
}

export default useSiteMetadata

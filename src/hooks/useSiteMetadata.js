import { graphql, useStaticQuery } from 'gatsby';

const useSiteMetadata = () => {
  const { site } = useStaticQuery(
    graphql`
      query SiteMetaData {
        site {
          siteMetadata {
            title
            siteUrl
            description
            logo
            navLinks {
              name
              url
            }
          }
        }
        allFile(filter: { sourceInstanceName: { eq: "images" } }) {
          edges {
            node {
              name
              publicURL
            }
          }
        }
      }
    `
  );
  return site.siteMetadata;
};

export default useSiteMetadata;

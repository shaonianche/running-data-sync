module.exports = {
  pathPrefix: '/',
  siteMetadata: {
    siteTitle: 'Running',
    siteUrl: 'https://run.duangfei.org/',
    description: 'Personal site and blog',
    logo: 'https://raw.githubusercontent.com/shaonianche/gallery/master/running_page/running_page_logo_600*600.jpg',
    navLinks: [
      {
        name: 'Blog',
        url: 'https://blog.duanfei.org',
      },
      {
        name: 'About',
        url: 'https://blog.duanfei.org/about',
      },
    ],
  },

  plugins: [
    'gatsby-transformer-json',
    'gatsby-plugin-postcss',
    {
      resolve: 'gatsby-source-filesystem',
      options: {
        path: './src/static/',
      },
    },
    {
      resolve: 'gatsby-source-filesystem',
      options: {
        path: './src/images/',
      },
    },
    {
      resolve: 'gatsby-alias-imports',
      options: {
        rootFolder: './',
      },
    },
    {
      resolve: 'gatsby-plugin-sass',
      options: {
        cssLoaderOptions: {
          esModule: false,
          modules: {
            namedExport: false,
          },
        },
      },
    },
    {
      resolve: 'gatsby-plugin-react-svg',
      options: {
        rule: {
          include: /assets/,
        },
      },
    },
    {
      resolve: 'gatsby-plugin-manifest',
      options: {
        name: 'gatsby-starter-default',
        short_name: 'starter',
        start_url: '/',
        background_color: '#e1e1e1',
        theme_color: '#e1e1e1',
        display: 'minimal-ui',
        icon: 'src/images/favicon.png', // This path is relative to the root of the site.
      },
    },
  ],
}

module.exports = {
  pathPrefix: '/',
  siteMetadata: {
    siteTitle: 'Running',
    siteUrl: 'https://run.duangfei.org/',
    description: 'Personal site and blog',
    logo: './logo.jpg',
    navLinks: [
      {
        name: 'Blog',
        url: 'https://blog.duanfei.org/#/all-journals',
      },
      {
        name: 'About',
        url: 'https://blog.duanfei.org/#/page/contents',
      },
    ],
  },

  plugins: [
    'gatsby-transformer-json',
    'gatsby-plugin-postcss',
    'gatsby-plugin-pnpm',
    'gatsby-plugin-react-helmet',
    {
      resolve: 'gatsby-source-filesystem',
      options: {
        name: 'static',
        path: './src/static/',
      },
    },
    {
      resolve: "gatsby-plugin-vercel",
      options: {
        // (optional) Prints metrics in the console when true
        debug: false,
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
        start_url: './',
        background_color: '#1A1A1A',
        theme_color: '#1A1A1A',
        display: 'minimal-ui',
        icon: './static/favicon.png', // This path is relative to the root of the site.
      },
    },
  ],
}

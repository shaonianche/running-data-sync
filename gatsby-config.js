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
        url: 'https://blog.duanfei.org'
      },
      {
        name: 'About',
        url: 'https://blog.duanfei.org/about'
      }
    ]
  },

  plugins: [
    'gatsby-transformer-json',
    {
      resolve: 'gatsby-source-filesystem',
      options: {
        name: 'data',
        path: './src/static'
      }
    },
    {
      resolve: 'gatsby-source-filesystem',
      options: {
        name: 'images',
        path: './src/images'
      }
    },
    {
      resolve: 'gatsby-alias-imports',
      options: {
        rootFolder: './'
      }
    },
    'gatsby-plugin-react-helmet',
    {
      resolve: 'gatsby-transformer-remark',
      options: {
        plugins: [
          'gatsby-remark-responsive-iframe',
          'gatsby-remark-smartypants',
          'gatsby-remark-widows',
          'gatsby-remark-external-links',
          {
            resolve: 'gatsby-remark-autolink-headers',
            options: {
              className: 'header-link'
            }
          }
        ]
      }
    },
    {
      resolve: 'gatsby-plugin-sass',
      options: {
        precision: 8
      }
    },
    {
      resolve: 'gatsby-plugin-react-svg',
      options: {
        rule: {
          include: /assets/
        }
      }
    },
    'gatsby-plugin-image',
    'gatsby-plugin-sharp',
    {
      resolve: 'gatsby-transformer-sharp',
      options: {
        // The option defaults to true
        checkSupportedExtensions: true
      }
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
        icon: 'src/images/logo-favicon.png' // This path is relative to the root of the site.
      }
    },
    'gatsby-plugin-sitemap',
    {
      resolve: 'gatsby-plugin-robots-txt',
      options: {
        policy: [{ userAgent: '*', allow: '/' }]
      }
    },
    {
      resolve: 'gatsby-plugin-firebase',
      options: {
        credentials: {
          apiKey: 'AIzaSyDjHBC567IJXStrdCrXxpmd7hdwHSN-eMY',
          authDomain: 'running-data-sync.firebaseapp.com',
          // databaseURL: 'running-data-sync.firebaseapp.com',
          projectId: 'running-data-sync',
          storageBucket: 'running-data-sync.appspot.com',
          messagingSenderId: '967054291585',
          appId: '1:967054291585:web:ea3c6b820c0ff2373c9380',
          measurementId: 'G-1RMYP62RLZ'
        }
      }
    }
  ]
};

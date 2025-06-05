interface ISiteMetadataResult {
  siteTitle: string
  siteUrl: string
  description: string
  logo: string
  navLinks: {
    name: string
    url: string
  }[]
}

const data: ISiteMetadataResult = {
  siteTitle: 'Running',
  siteUrl: 'https://run.duanfei.org/',
  logo: 'https://dgalywyr863hv.cloudfront.net/pictures/athletes/67102018/20181159/2/large.jpg',
  description: 'Personal site and blog',
  navLinks: [
    {
      name: 'Blog',
      url: 'https://blog.duanfei.org/',
    },
    {
      name: 'About',
      url: 'https://github.com/shaonianche',
    },
  ],
}

export default data

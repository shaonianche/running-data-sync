interface ISiteMetadataResult {
    siteTitle: string;
    siteUrl: string;
    description: string;
    logo: string;
    navLinks: {
      name: string;
      url: string;
    }[];
  }
  
  const data: ISiteMetadataResult = {
    siteTitle: 'Running',
    siteUrl: 'https://run.duanfei.org/',
    logo: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQTtc69JxHNcmN1ETpMUX4dozAgAN6iPjWalQ&usqp=CAU',
    description: 'Personal site and blog',
    navLinks: [
      {
        name: 'Blog',
        url: 'https://note.duanfei.org/#/page/contents',
      },
      {
        name: 'About',
        url: 'https://note.duanfei.org/#/page/contents',
      },
    ],
  };
  
  export default data;

import React from 'react';
import { Helmet } from 'react-helmet';
import Header from 'src/components/Header';
import useSiteMetadata from 'src/hooks/useSiteMetadata';
import 'src/styles/index.scss';
import styles from './style.module.scss';

const Layout = ({ children }) => {
  const { title, description } = useSiteMetadata();
  return (
    <div>
      <Helmet bodyAttributes={{ class: styles.body }}>
        <html lang="en" />
        <title>{title}</title>
        <meta name="description" content={description} />
        <meta name="keywords" content="running" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
      </Helmet>
      <Header siteTitle={title} />
      <div className="pa3 pa5-l" style={{ paddingTop: '2rem' }}>
        {children}
      </div>
    </div>
  );
};

export default Layout;

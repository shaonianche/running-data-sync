import PropTypes from 'prop-types';
import React from 'react';
import { Helmet } from 'react-helmet';
import Header from 'src/components/Header';
import useSiteMetadata from 'src/hooks/useSiteMetadata';
import 'src/styles/index.scss';
import styles from './style.module.scss';

const Layout = ({ children }) => {
  const { favicon, title, description } = useSiteMetadata();

  return (
    <>
      <Helmet
        title={title}
        meta={[
          {
            name: 'description',
            content: description,
          },
          { name: 'keywords', content: 'running' },
        ]}
        bodyAttributes={{ class: styles.body }}

      >
        <link rel="icon" href={favicon} />
        <html lang="en" />
      </Helmet>
      <Header siteTitle={title} />
      <div className="pa3 pa5-l">{children}</div>
    </>
  );
};

Layout.propTypes = {
  children: PropTypes.node.isRequired,
};

export default Layout;

import PropTypes from 'prop-types';
import React from 'react';
import { Helmet } from 'react-helmet';
import Header from 'src/components/Header';
import useSiteMetadata from 'src/hooks/useSiteMetadata';
import logo_favicon from 'src/images/logo_favicon.png';
import 'src/styles/index.scss';
import styles from './style.module.scss';

const Layout = ({ children }) => {
  const { title, description } = useSiteMetadata();

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
        link={[

          { rel: 'shortcut icon', type: 'image/png', href: `${logo_favicon}` },
        ]}
        bodyAttributes={{ class: styles.body }}

      >
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

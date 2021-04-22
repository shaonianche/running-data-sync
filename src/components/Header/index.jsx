import { Link } from 'gatsby';
import React from 'react';
import useSiteMetadata from 'src/hooks/useSiteMetadata';
import { NAVS } from 'src/utils/const';

const Header = ({ siteTitle }) => {
  const { logo,siteUrl } = useSiteMetadata();

  if (!NAVS) return null;
  return (
    <>
      <nav
        className="db flex justify-between w-100 ph5-l"
        style={{ marginTop: '3rem' }}
      >
        <div className="dib w-25 v-mid">
          <Link to={siteUrl} className="link dim">
            <picture>
              <img
                className="dib w3 h3 br-100"
                alt="logo"
                src={logo}
              />
            </picture>
          </Link>
        </div>
        {/* {NAVS && (
          <div className="dib w-75 v-mid tr">
            {NAVS.map((n, i) => (
              <a
                key={i}
                href={n.link}
                className="light-gray link dim f6 f5-l mr3 mr4-l"
              >
                {n.text}
              </a>
            ))}
          </div>
        )}  */}
      </nav>
    </>
  );
};


export default Header;

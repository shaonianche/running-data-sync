import React from 'react'
import YearStat from 'src/components/YearStat'
import CitiesStat from './CitiesStat'
import LocationSummary from './LocationSummary'
import PeriodStat from './PeriodStat'

const LocationStat = ({ changeYear, changeCity, changeTitle }) => (
  <div className="fl w-100 w-30-l pb5 pr5-l">
    <section className="pb4" style={{ paddingBottom: '0rem' }}>
      <p>Yesterday you said tomorrow.</p>
    </section>
    <hr color="red" />
    <LocationSummary />
    <CitiesStat onClick={changeCity} />
    <PeriodStat onClick={changeTitle} />
    <YearStat year="Total" onClick={changeYear} />
  </div>
)

export default LocationStat

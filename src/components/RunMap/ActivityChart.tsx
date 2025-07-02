import React, { useEffect, useState } from 'react'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { initDuckDB, loadDuckDBFile } from '@/utils/utils'
import styles from './style.module.css'

interface ActivityChartProps {
  thisYear: string
}

interface MonthlyRunDistanceData {
  month: string
  total_distance_km: number
}

interface YearlyRunDistanceData {
  year: string
  total_distance_km: number
}

const ActivityChart: React.FC<ActivityChartProps> = ({ thisYear }) => {
  const [data, setData] = useState<MonthlyRunDistanceData[] | YearlyRunDistanceData[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true

    async function fetchData() {
      if (!thisYear) {
        setData([])
        setLoading(false)
        return
      }

      setLoading(true)
      setError(null)
      setData([])

      try {
        const { db } = await initDuckDB()
        const conn = await loadDuckDBFile(db, '/db/activities.parquet', 'activities.parquet')

        let query = ''
        if (thisYear === 'Total') {
          query = `
            SELECT
              SUBSTRING(start_date_local, 1, 4) AS year,
              SUM(distance / 1000.0) AS total_distance_km
            FROM activities.parquet
            GROUP BY year
            HAVING SUM(distance / 1000.0) > 0
            ORDER BY year ASC;
          `
        }
        else {
          query = `
            SELECT
              SUBSTRING(start_date_local, 6, 2) AS month,
              SUM(distance / 1000.0) AS total_distance_km
            FROM activities.parquet
            WHERE SUBSTRING(start_date_local, 1, 4) = '${thisYear}'
            GROUP BY month
            HAVING SUM(distance / 1000.0) > 0
            ORDER BY month ASC;
          `
        }

        const result = await conn.query(query)
        if (isMounted) {
          const rawData = result.toArray()
          const processedData = rawData.map((row: any) => {
            const newRow: any = {}
            for (const key in row) {
              if (typeof row[key] === 'bigint') {
                newRow[key] = Number(row[key])
              }
              else {
                newRow[key] = row[key]
              }
            }
            if (newRow.total_distance_km !== undefined) {
              newRow.total_distance_km = Number(newRow.total_distance_km)
            }
            return newRow
          })

          if (thisYear === 'Total') {
            setData(processedData as YearlyRunDistanceData[])
          }
          else {
            setData(processedData as MonthlyRunDistanceData[])
          }
        }
      }
      catch (e: any) {
        if (isMounted) {
          setError(e.message)
          console.error('Failed to fetch activity data for:', thisYear, e)
        }
      }
      finally {
        if (isMounted) {
          setLoading(false)
        }
      }
    }

    fetchData()

    return () => {
      isMounted = false
    }
  }, [thisYear])

  if (loading) {
    return (
      <div className={styles.loadingText}>
        加载中
        {' '}
        {thisYear === 'Total' ? '所有年份' : `${thisYear}年`}
        {' '}
        的跑量数据...
      </div>
    )
  }

  if (error) {
    return (
      <div className={styles.errorText}>
        加载数据出错 (
        {thisYear}
        ):
        {' '}
        {error}
      </div>
    )
  }

  const renderChart = () => {
    if (data.length === 0) {
      return (
        <p className={styles.noDataText}>
          没有找到
          {thisYear === 'Total' ? '任何年份' : `${thisYear}年`}
          {' '}
          的跑量数据。
        </p>
      )
    }

    if (thisYear === 'Total') {
      const chartData = data as YearlyRunDistanceData[]
      return (
        <ResponsiveContainer width="95%" height={300}>
          <BarChart
            data={chartData}
            margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="year" name="年份" />
            <YAxis name="总跑量 (km)" unit=" km" />
            <Tooltip formatter={(value: number) => [`${value.toFixed(2)} km`, '年跑量']} />
            <Legend />
            <Bar dataKey="total_distance_km" fill="var(--color-svg-total-line)" name="年跑量 (km)" />
          </BarChart>
        </ResponsiveContainer>
      )
    }
    else {
      const chartData = data as MonthlyRunDistanceData[]
      return (
        <ResponsiveContainer width="95%" height={300}>
          <BarChart
            data={chartData}
            margin={{ top: 20, right: 30, left: 20, bottom: 5 }}
          >
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="month" name="月份" />
            <YAxis name="跑量 (km)" unit=" km" />
            <Tooltip formatter={(value: number) => [`${value.toFixed(2)} km`, '月跑量']} />
            <Legend />
            <Bar dataKey="total_distance_km" fill="var(--color-svg-line)" name="月跑量 (km)" />
          </BarChart>
        </ResponsiveContainer>
      )
    }
  }

  return (
    <div className={styles.chartContainer}>
      <h3 className={styles.chartTitle}>
        {thisYear === 'Total'}
      </h3>
      <div className={styles.chartWrapper}>
        {renderChart()}
      </div>
    </div>
  )
}

export default ActivityChart

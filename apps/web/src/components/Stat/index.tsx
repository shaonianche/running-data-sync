import { intComma } from '@/utils/utils'
import styles from './style.module.css'

interface IStatProperties {
  value: string | number
  description: string
  className?: string
  citySize?: number
  onClick?: () => void
}

const textSizeClass: Record<number, string> = {
  3: styles.size3,
  4: styles.size4,
  5: styles.size5,
  6: styles.size6,
}

function Stat({
  value,
  description,
  className = styles.root,
  citySize,
  onClick,
}: IStatProperties) {
  const sizeClass = textSizeClass[citySize ?? 5] || styles.size5
  const isClickable = !!onClick

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (onClick && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      onClick()
    }
  }

  return (
    <div
      className={className}
      onClick={onClick}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      onKeyDown={isClickable ? handleKeyDown : undefined}
    >
      <span className={`${styles.value} ${sizeClass}`}>
        {intComma(value.toString())}
      </span>
      <span className={styles.description}>{description}</span>
    </div>
  )
}

export default Stat

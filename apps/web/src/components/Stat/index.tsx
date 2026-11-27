import { intComma } from '@/utils/utils'

interface IStatProperties {
  value: string | number
  description: string
  className?: string
  citySize?: number
  onClick?: () => void
}

const textSizeClass: Record<number, string> = {
  3: 'md:text-3xl',
  4: 'md:text-4xl',
  5: 'md:text-5xl',
  6: 'md:text-6xl',
}

function Stat({
  value,
  description,
  className = 'pb-2 w-full',
  citySize,
  onClick,
}: IStatProperties) {
  const sizeClass = textSizeClass[citySize ?? 5] || 'md:text-5xl'
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
      <span className={`font-bold italic text-3xl sm:text-4xl ${sizeClass}`}>
        {intComma(value.toString())}
      </span>
      <span className="font-semibold italic text-sm sm:text-base md:text-lg">{description}</span>
    </div>
  )
}

export default Stat

import { intComma } from '@/utils/utils'

interface IStatProperties {
  value: string | number
  description: string
  className?: string
  citySize?: number
  onClick?: () => void
}

function Stat({
  value,
  description,
  className = 'pb-2 w-full',
  citySize,
  onClick,
}: IStatProperties) {
  return (
    <div className={`${className}`} onClick={onClick}>
      <span className={`font-bold italic text-3xl sm:text-4xl md:text-${citySize || 5}xl`}>
        {intComma(value.toString())}
      </span>
      <span className="font-semibold italic text-sm sm:text-base md:text-lg">{description}</span>
    </div>
  )
}

export default Stat

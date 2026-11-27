import { useRef, useState } from 'react'

type HoverHook = [boolean, { onMouseOver: () => void, onMouseOut: () => void }]

function useHover(): HoverHook {
  const [hovered, setHovered] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const eventHandlers = {
    onMouseOver() {
      timerRef.current = setTimeout(() => setHovered(true), 500)
    },
    onMouseOut() {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
      }
      setHovered(false)
    },
  }

  return [hovered, eventHandlers]
}

export default useHover

import { afterEach, describe, expect, it, vi } from 'vitest'
import { prefersReducedMotion } from './motion'
import { scrollToMap } from './utils'

function mockReducedMotion(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)' ? matches : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

describe('motion utilities', () => {
  afterEach(() => {
    mockReducedMotion(false)
    document.body.innerHTML = ''
  })

  it('returns false when prefers-reduced-motion does not match', () => {
    mockReducedMotion(false)
    expect(prefersReducedMotion()).toBe(false)
  })

  it('returns true when prefers-reduced-motion matches', () => {
    mockReducedMotion(true)
    expect(prefersReducedMotion()).toBe(true)
  })

  it('scrollToMap uses smooth scroll in normal motion mode', () => {
    mockReducedMotion(false)
    const el = document.createElement('div')
    el.id = 'run-map'
    const scrollIntoView = vi.fn()
    el.scrollIntoView = scrollIntoView
    document.body.appendChild(el)

    scrollToMap()
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' })
  })

  it('scrollToMap uses auto scroll when reduced motion is enabled', () => {
    mockReducedMotion(true)
    const el = document.createElement('div')
    el.id = 'run-map'
    const scrollIntoView = vi.fn()
    el.scrollIntoView = scrollIntoView
    document.body.appendChild(el)

    scrollToMap()
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' })
  })
})

import type { ComponentType } from 'react'

interface SvgComponent {
  default: ComponentType<any>
}

export async function loadSvgComponent(stats: Record<string, () => Promise<unknown>>, path: string): Promise<SvgComponent> {
  try {
    const module = await stats[path]()
    return { default: module as ComponentType<any> }
  }
  catch (error) {
    console.error(error)
    return { default: () => <div>Failed to load SVG</div> }
  }
}

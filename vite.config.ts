import process from 'node:process'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import svgr from 'vite-plugin-svgr'
import viteTsconfigPaths from 'vite-tsconfig-paths'

// The following are known larger packages or packages that can be loaded asynchronously.
const individuallyPackages = ['activities', 'github.svg', 'github-light.svg', 'grid.svg', 'grid-light.svg']

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteTsconfigPaths(),
    svgr({
      include: ['public/**/*.svg'],
      svgrOptions: {
        exportType: 'named',
        namedExport: 'ReactComponent',
        plugins: ['@svgr/plugin-svgo', '@svgr/plugin-jsx'],
        svgoConfig: {
          floatPrecision: 2,
          plugins: [
            {
              name: 'preset-default',
              params: {
                overrides: {
                  removeTitle: false,
                  removeViewBox: false,
                },
              },
            },
          ],
        },
      },
    }),
  ],
  base: process.env.PATH_PREFIX || '/',
  define: {
    'import.meta.env.VERCEL': JSON.stringify(process.env.VERCEL),
  },
  build: {
    manifest: true,
    outDir: './dist', // for user easy to use, vercel use default dir -> dist
    rollupOptions: {
      output: {
        manualChunks: (id: string) => {
          if (id.includes('node_modules')) {
            if (
              id.includes('/react/')
              || id.includes('/react-dom/')
              || id.includes('/scheduler/')
              || id.includes('/react-router')
              || id.includes('/react-helmet')
              || id.includes('/react-ga')
              || id.includes('/@vercel/analytics')
              || id.includes('/react-map-gl/')
              || id.includes('/maplibre-gl/')
            ) {
              return 'ui'
            }
            if (id.includes('/@duckdb/duckdb-wasm/')) {
              return 'duckdb'
            }
            if (id.includes('/recharts/') || id.includes('/d3-')) {
              return 'charts'
            }
            return 'vendors'
          }
          for (const item of individuallyPackages) {
            if (id.includes(item)) {
              return item
            }
          }
        },
      },
    },
  },
})

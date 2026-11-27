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
            // Async-only stacks (must NOT be merged into the eager vendor chunk).
            if (
              id.includes('/react-map-gl/')
              || id.includes('/@vis.gl/')
              || id.includes('/maplibre-gl/')
              || id.includes('/world-geo-json')
            ) {
              // Leave unassigned → follows lazy(() => import(RunMap)).
              return
            }
            if (id.includes('/@duckdb/duckdb-wasm/')) {
              return 'duckdb'
            }
            if (id.includes('/recharts/') || id.includes('/d3-')) {
              return 'charts'
            }
            // Single eager vendor chunk (includes React). Splitting react into
            // "ui" and everything else into "vendors" created a circular edge
            // and blank pages (Cannot set properties of undefined 'Activity').
            return 'vendor'
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

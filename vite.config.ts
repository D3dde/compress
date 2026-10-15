import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Deploy base. GitHub Pages project sites live under /<repo>/, so
 * `npm run build -- --base=/my-repo/` or BASE_PATH=/my-repo/ npm run build.
 */
const base = process.env.BASE_PATH ?? '/'

const crossOriginIsolation = {
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
}

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    headers: crossOriginIsolation,
  },
  preview: {
    headers: crossOriginIsolation,
  },
  build: {
    target: 'es2022',
  },
})
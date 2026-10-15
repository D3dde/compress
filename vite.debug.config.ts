import { defineConfig } from 'vite'
export default defineConfig({
  build: {
    outDir: 'dist-debug',
    rollupOptions: { input: { debug: 'debug.html' } },
  },
})

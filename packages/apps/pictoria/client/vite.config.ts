import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { browserDependencyOptions } from '../../../../scripts/vite-browser-compat'

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [vue()],
  optimizeDeps: browserDependencyOptions,
  server: {
    host: '127.0.0.1',
    port: 7363,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:9120', changeOrigin: true } },
  },
  build: { outDir: resolve(__dirname, 'dist'), target: 'es2022', cssCodeSplit: true },
})

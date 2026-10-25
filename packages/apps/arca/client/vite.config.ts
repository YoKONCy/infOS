import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'
import { browserDependencyOptions } from '../../../../scripts/vite-browser-compat'

export default defineConfig({
  root: __dirname,
  base: './',
  plugins: [vue()],
  optimizeDeps: browserDependencyOptions,
  resolve: {
    alias: {
      '@arca/client': resolve(__dirname, 'src'),
      '@infos/shared': resolve(__dirname, '../../../shared/src'),
      '@infos/node-sdk': resolve(__dirname, '../../../node-sdk/src'),
      '@infos/document-engine': resolve(__dirname, '../../../document-engine/src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 7362,
    proxy: {
      '/api': { target: 'http://127.0.0.1:9120', changeOrigin: true },
    },
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    target: 'es2022',
    cssCodeSplit: true,
    assetsInlineLimit: 4096,
  },
})

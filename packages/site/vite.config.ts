import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { browserDependencyOptions, browserTargets } from '../../scripts/vite-browser-compat'

// 官网是纯静态单页，部署位置未定，使用相对路径以便放在任意目录
export default defineConfig({
  base: './',
  plugins: [vue()],
  optimizeDeps: browserDependencyOptions,
  build: { target: browserTargets },
  server: { host: '127.0.0.1', port: 6658 },
})

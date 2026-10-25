/**
 * @file electron-vite 开发配置
 * @description 同时启动 Electron 主进程 + 预加载 + Vue 前端的 Dev Server
 *
 * 启动方式: pnpm dev:electron
 *
 * @see .docs/A04_DEPLOYMENT.md — Electron 部署规范
 */

import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { pdfAssetsPlugin } from './scripts/pdfAssetsPlugin'
import { browserDependencyOptions } from './scripts/vite-browser-compat'

// 从根 package.json 读取版本号
const rootPkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf8'))
const APP_VERSION: string = rootPkg.version

export default defineConfig({
  // ── 主进程 ──────────────────────────────────────────────
  main: {
    // 纯 TS Workspace 头像适配包必须内联进 app.asar；运行时不能依赖 pnpm 工作区链接。
    plugins: [externalizeDepsPlugin({ exclude: ['@infos/avatar-assets'] })],
    resolve: {
      alias: {
        '@infos/avatar-assets': resolve(__dirname, 'packages/avatar-assets/src'),
      },
    },
    build: {
      outDir: 'dist-electron/main',
      rollupOptions: {
        input: resolve(__dirname, 'electron/main/index.ts'),
        // bufferutil / utf-8-validate 是 ws 的可选原生依赖
        // 在 Electron 环境经常无法编译，ws 内部已 try/catch 容错
        // 标记为 external 避免 Rollup 尝试解析它们
        external: ['winreg', 'steamworks.js', 'bufferutil', 'utf-8-validate'],
      },
    },
  },

  // ── 预加载脚本 ────────────────────────────────────────
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload/index.ts'),
          startupSplash: resolve(__dirname, 'electron/preload/startupSplash.ts'),
        },
      },
    },
  },

  // ── 渲染进程 (Vue 前端) ───────────────────────────────
  renderer: {
    root: resolve(__dirname, 'packages/frontend'),
    publicDir: resolve(__dirname, 'public'),
    plugins: [vue(), tailwindcss(), pdfAssetsPlugin(resolve(__dirname, 'packages/frontend'))],
    optimizeDeps: browserDependencyOptions,
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'packages/frontend/src'),
        '@infos/avatar-assets': resolve(__dirname, 'packages/avatar-assets/src'),
        '@infos/arca/manifest': resolve(__dirname, 'packages/apps/arca/src/manifest.ts'),
        '@infos/shared': resolve(__dirname, 'packages/shared/src'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 7359,
      strictPort: true,
      hmr: { path: '/__infos_hmr' },
      fs: {
        allow: [
          resolve(__dirname, 'packages/frontend'),
          resolve(__dirname, 'packages/shared/src'),
          resolve(__dirname, 'packages/avatar-assets/src'),
          resolve(__dirname, 'packages/apps/arca/src'),
          resolve(__dirname, 'node_modules'),
          resolve(__dirname, 'public'),
        ],
      },
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${process.env.PERO_PORT || 9120}`,
          changeOrigin: false,
        },
        '/ws': { target: `ws://127.0.0.1:${process.env.PERO_PORT || 9120}`, ws: true },
      },
    },
    build: {
      outDir: resolve(__dirname, 'dist/renderer'),
      rollupOptions: {
        input: resolve(__dirname, 'packages/frontend/index.html'),
      },
    },
  },
})

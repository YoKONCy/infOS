import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

/**
 * @file Vitest 全局配置
 * @description规范
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    // 全局 API（不需要每个文件 import describe/it/expect）
    globals: true,

    // 默认测试环境（后端用 node，前端各包覆盖为 happy-dom）
    environment: 'node',
    env: { INFOS_TEST_TEMP_ROOT: resolve(__dirname, 'TEMP'), INFOS_LANGUAGE: 'zh-CN' },
    // 持久工具原件等测试数据必须隔离，清理测试夹具不能触碰真实用户目录。
    setupFiles: [
      resolve(__dirname, 'packages/backend/tests/runtimeDataSetup.ts'),
      resolve(__dirname, 'packages/shared/tests/localeSetup.ts'),
    ],

    // 文件匹配（除 tests/ 目录外，也支持源码内的 __tests__ 同位目录）
    include: [
      'packages/*/tests/**/*.{test,spec}.{ts,tsx}',
      'packages/apps/*/tests/**/*.{test,spec}.{ts,tsx}',
      'packages/apps/*/client/tests/**/*.{test,spec}.{ts,tsx}',
      'packages/apps/*/client/src/**/__tests__/**/*.{test,spec}.{ts,tsx}',
      'packages/*/src/**/__tests__/**/*.{test,spec}.{ts,tsx}',
      'electron/{main,preload}/**/*.{test,spec}.{ts,tsx}',
    ],
    // 按协作约定排除界面、视觉与动效用例，保留核心行为和数据契约测试。
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'packages/frontend/tests/unit/components/**',
      'packages/frontend/tests/unit/avatarPerformance.test.ts',
      'packages/frontend/tests/unit/avatarRendering.test.ts',
      'packages/frontend/tests/unit/userAvatarCrop.test.ts',
      'packages/frontend/tests/unit/composables/navigationMotion.test.ts',
      'packages/frontend/tests/unit/composables/avatarInteraction.test.ts',
      'packages/frontend/tests/unit/composables/windowVisibility.test.ts',
      'packages/frontend/tests/unit/workspaceFullscreen.test.ts',
      'packages/frontend/tests/unit/workspaceImageViewer.test.ts',
      'packages/frontend/tests/unit/workspacePdfPage.test.ts',
      'packages/frontend/tests/unit/workspacePdfViewer.test.ts',
      'packages/frontend/tests/unit/workspaceTerminalScreen.test.ts',
      'packages/frontend/tests/unit/toolCallCard.test.ts',
      'packages/apps/arca/client/tests/confirmDialog.test.ts',
      'packages/apps/arca/client/tests/visualSystemV2.test.ts',
      'packages/apps/pictoria/client/tests/canvasCardCandidates.test.ts',
      'packages/apps/pictoria/client/tests/proposalReview.test.ts',
      'electron/preload/desktopEntry.test.ts',
      'electron/main/utils/windowsSystemBackdrop.test.ts',
      'electron/main/windows/manager.test.ts',
      'electron/main/windows/windowState.test.ts',
      'electron/main/windows/desktopTabs.test.ts',
      'electron/main/windows/desktopToasts.test.ts',
    ],
    testNamePattern: /^(?!.*(?:useChatInput|隐藏主界面时合并增量|动画帧停止时失败终态)).*$/u,

    // 覆盖率配置
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/*.d.ts',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types/**',
        '**/constants/**',
        '**/index.ts',
      ],
    },

    // 路径别名（与 tsconfig 对齐）
    alias: {
      '@infos/shared': resolve(__dirname, 'packages/shared/src'),
      '@infos/backend': resolve(__dirname, 'packages/backend/src'),
      '@infos/document-engine': resolve(__dirname, 'packages/document-engine/src'),
      '@infos/node-sdk': resolve(__dirname, 'packages/node-sdk/src'),
      '@infos/node-host': resolve(__dirname, 'packages/node-host/src'),
      '@infos/frontend': resolve(__dirname, 'packages/frontend/src'),
      '@infos/arca': resolve(__dirname, 'packages/apps/arca/src'),
      '@infos/pictoria': resolve(__dirname, 'packages/apps/pictoria/src'),
      '@infos/social': resolve(__dirname, 'packages/apps/social'),
    },
  },
})

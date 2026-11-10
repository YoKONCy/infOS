import { t as __t } from '../i18n/index'
/**
 * Vue Router 配置
 *
 * 统一单页路由: Electron 和 Docker/浏览器共用 MainView 综合面板。
 * LauncherView 和 Pet3DView 保持独立路由。
 *
 * 路由结构:
 * - /           → /app (MainView,默认对话 Tab)
 * - /app        → MainView
 * - /launcher   → LauncherView
 * - /pet-3d     → Pet3DView (仅 Electron 可访问)
 * - /panel/:id  → DetachedPanelView (桌面外壳面板窗口)
 *
 * @module packages/frontend/src/router
 */

import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'
import { isElectron } from '../utils/ipcAdapter'

// ── 统一路由 ──

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    redirect: '/app',
  },
  {
    path: '/app',
    name: 'Main',
    component: () => import('@/views/MainView.vue'),
    meta: { title: 'PeroperoChat' },
  },
  isElectron()
    ? {
        path: '/launcher',
        name: 'Launcher',
        component: () => import('@/views/LauncherView.vue'),
        meta: {
          get title() {
            return __t('ui.index', '启动器')
          },
        },
      }
    : {
        path: '/launcher',
        redirect: '/app',
      },
  isElectron()
    ? {
        path: '/pet-3d',
        name: 'PetStandalone',
        component: () => import('@/views/Pet3DView.vue'),
        meta: {
          get title() {
            return __t('ui.index', '桌宠')
          },
          standalone: true,
        },
      }
    : {
        // 浏览器/Docker 模式不支持透明桌宠窗口
        path: '/pet-3d',
        redirect: '/app',
      },
  // 桌面外壳面板窗口：只渲染单个功能页。入口只在 Electron 提供，浏览器中打开时不显示窗口控制。
  {
    path: '/panel/:pageId',
    name: 'DetachedPanel',
    component: () => import('@/views/DetachedPanelView.vue'),
    meta: { title: 'PeroperoChat', standalone: true },
  },
]

// ── 创建路由实例 ──

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

// 路由切换时更新标题
router.afterEach((to) => {
  document.title = `${to.meta.title ?? 'PeroperoChat'} - PeroperoChat`
})

export default router

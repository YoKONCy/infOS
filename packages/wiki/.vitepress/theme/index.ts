/**
 * Wiki 自定义主题入口
 *
 * 在 VitePress 默认主题上替换布局插槽（陪读、404），并注册正文可用的全局组件。
 *
 * @module packages/wiki/.vitepress/theme
 */

import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'
import Layout from './Layout.vue'
import HomePage from '../components/HomePage.vue'
import CompanionNote from '../components/CompanionNote.vue'
import BedrockDemo from '../components/BedrockDemo.vue'
import Mermaid from '../components/Mermaid.vue'
import './style.css'

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component('HomePage', HomePage)
    app.component('CompanionNote', CompanionNote)
    app.component('BedrockDemo', BedrockDemo)
    app.component('Mermaid', Mermaid)
  },
} satisfies Theme

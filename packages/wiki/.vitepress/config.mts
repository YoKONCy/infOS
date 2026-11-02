/**
 * VitePress 站点配置
 *
 * infOS Wiki 萌动像素风文档站
 *
 * @see https://vitepress.dev/reference/site-config
 * @module packages/wiki/.vitepress/config
 */

import { defineConfig } from 'vitepress'
import mathjax3 from 'markdown-it-mathjax3'
import fs from 'fs'
import path from 'path'
import { cjkFriendlyEmphasis } from './plugins/cjkFriendlyEmphasis'
import { markdownMermaid } from './plugins/markdownMermaid'
import { browserDependencyOptions, browserTargets } from '../../../scripts/vite-browser-compat'

export default defineConfig({
  vite: {
    optimizeDeps: browserDependencyOptions,
    build: { target: browserTargets },
  },
  title: 'Perofamily Wiki',
  description: 'Documentation for infOS - The AI Desktop Companion',
  // 自定义域名 www.perofamily.top 从根路径提供文档站。
  head: [
    ['link', { rel: 'icon', href: '/Logo.png' }],
    // 异步非阻塞加载外部字体，配置本地字体优雅回退，避免因网络波动阻塞渲染
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=ZCOOL+KuaiLe&family=Ma+Shan+Zheng&display=swap',
        media: 'print',
        onload: "this.media='all'",
      },
    ],
  ],
  appearance: false, // 禁用深色模式切换，统一使用全天候萌动色 🌸
  markdown: {
    config: (md) => {
      // MathJax 数学公式渲染
      md.use(mathjax3)
      // CJK 中文排版及标点加粗自愈增强插件
      md.use(cjkFriendlyEmphasis)
      // Mermaid 流程图渲染插件
      md.use(markdownMermaid)
    },
    languages: [
      // NIT 协议语法高亮
      {
        ...JSON.parse(
          fs.readFileSync(path.resolve(__dirname, './grammars/nit.tmLanguage.json'), 'utf-8'),
        ),
      },
    ],
  },
  themeConfig: {
    logo: '/Logo.png',
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: '首页', link: '/' },
      { text: '指南', link: '/guide/intro' },
    ],

    sidebar: [
      {
        text: '📘 指南',
        items: [
          { text: '项目简介', link: '/guide/intro' },
          { text: '快速上手', link: '/guide/usage' },
        ],
      },
      {
        text: '🧠 核心系统',
        items: [
          { text: 'AIOS 架构', link: '/core-systems/aios' },
          { text: '上下文编译', link: '/core-systems/context' },
          { text: '工具与能力', link: '/core-systems/tools' },
          { text: '工作区与任务', link: '/core-systems/workspace-tasks' },
          { text: '记忆与知识', link: '/core-systems/memory' },
          { text: '拓展与子应用', link: '/core-systems/extensions-apps' },
        ],
      },
      {
        text: '⚙️ 外围系统',
        items: [
          { text: '控制面板', link: '/peripheral-systems/dashboard' },
          { text: '对话与工作区', link: '/peripheral-systems/conversation-workspace' },
          { text: '据点（群聊）模式', link: '/peripheral-systems/stronghold' },
          { text: '社交模式', link: '/peripheral-systems/social' },
          { text: '提示词框架', link: '/core-systems/mdp' },
          { text: '内置浏览器', link: '/peripheral-systems/browser' },
          { text: 'Bedrock 3D 引擎', link: '/peripheral-systems/bedrock' },
          { text: '角色管理', link: '/peripheral-systems/character' },
        ],
      },
      {
        text: '🌐 生态扩展',
        items: [
          { text: '插件', link: '/ecosystem/plugins' },
          { text: 'Skills 与 MCP', link: '/ecosystem/skills-mcp' },
          { text: '3D 模型', link: '/ecosystem/models' },
          { text: '移动端 App', link: '/ecosystem/mobile' },
        ],
      },
      {
        text: '🚀 部署运维',
        items: [
          { text: '分布式', link: '/deployment/distributed' },
          { text: 'Docker 部署', link: '/deployment/docker' },
        ],
      },
    ],

    socialLinks: [{ icon: 'github', link: 'https://github.com/YoKONCy/infOS' }],
  },
})

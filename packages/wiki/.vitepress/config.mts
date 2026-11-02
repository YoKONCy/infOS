/**
 * VitePress 站点配置
 *
 * 萌动链接：PeroperoChat！使用文档。读者以普通用户为主，侧栏按「想做什么」分组，
 * 开发者内容集中在「进阶与原理」。
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

const REPO = 'https://github.com/YoKONCy/infOS'

export default defineConfig({
  vite: {
    optimizeDeps: browserDependencyOptions,
    build: { target: browserTargets },
  },
  lang: 'zh-CN',
  title: '萌动链接 Wiki',
  description:
    '萌动链接：PeroperoChat！与 infOS 的使用文档：安装上手、和伙伴相处、请伙伴帮忙，以及部署与原理。',
  // 自定义域名 wiki.perofamily.top 从根路径提供文档站。
  head: [
    ['link', { rel: 'icon', type: 'image/png', href: '/favicon.png' }],
    ['link', { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' }],
    ['meta', { name: 'theme-color', content: '#fbfcfe', media: '(prefers-color-scheme: light)' }],
    ['meta', { name: 'theme-color', content: '#12161f', media: '(prefers-color-scheme: dark)' }],
  ],
  markdown: {
    config: (md) => {
      // MathJax 数学公式渲染
      md.use(mathjax3)
      // CJK 中文排版及标点加粗修正
      md.use(cjkFriendlyEmphasis)
      // Mermaid 流程图渲染插件
      md.use(markdownMermaid)
    },
    container: {
      tipLabel: '提示',
      warningLabel: '注意',
      dangerLabel: '危险',
      infoLabel: '说明',
      detailsLabel: '详细信息',
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
    logo: { src: '/logo-96.png', alt: '萌动链接' },
    siteTitle: '萌动链接 Wiki',

    nav: [
      { text: '开始使用', link: '/guide/intro', activeMatch: '^/guide/' },
      {
        text: '使用指南',
        activeMatch: '^/(companion|work)/',
        items: [
          { text: '和伙伴相处', link: '/companion/chat' },
          { text: '请伙伴帮忙', link: '/work/tools' },
        ],
      },
      { text: '部署', link: '/deployment/docker', activeMatch: '^/deployment/' },
      { text: '进阶', link: '/advanced/prompts', activeMatch: '^/advanced/' },
      {
        text: '下载',
        items: [
          { text: 'Steam 商店页', link: 'https://store.steampowered.com/app/4457100' },
          { text: 'GitHub Releases', link: `${REPO}/releases/latest` },
        ],
      },
    ],

    // 分组标题前的 01、02 编号由 style.css 用计数器生成
    sidebar: [
      {
        text: '开始使用',
        items: [
          { text: '项目简介', link: '/guide/intro' },
          { text: '安装与上手', link: '/guide/usage' },
          { text: '主界面导览', link: '/guide/dashboard' },
        ],
      },
      {
        text: '和伙伴相处',
        items: [
          { text: '对话与工作区', link: '/companion/chat' },
          { text: '桌宠与 3D 造型', link: '/companion/desktop-pet' },
          { text: '角色管理', link: '/companion/character' },
          { text: '记忆与知识', link: '/companion/memory' },
          { text: '据点（群聊）', link: '/companion/stronghold' },
          { text: '社交平台', link: '/companion/social' },
        ],
      },
      {
        text: '请伙伴帮忙',
        items: [
          { text: '工具与权限', link: '/work/tools' },
          { text: '工作区与任务', link: '/work/tasks' },
          { text: '内置浏览器', link: '/work/browser' },
          { text: '插件、技能与子应用', link: '/work/extensions' },
        ],
      },
      {
        text: '部署与多设备',
        items: [
          { text: 'Docker 部署', link: '/deployment/docker' },
          { text: '多设备与分布式', link: '/deployment/distributed' },
        ],
      },
      {
        text: '进阶与原理',
        items: [
          { text: '提示词框架', link: '/advanced/prompts' },
          { text: '上下文编译', link: '/advanced/context' },
          { text: 'AIOS 架构', link: '/advanced/aios' },
        ],
      },
    ],

    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一页', next: '下一页' },
    editLink: {
      pattern: `${REPO}/edit/main/packages/wiki/:path`,
      text: '在 GitHub 上修改这一页',
    },
    darkModeSwitchLabel: '外观',
    lightModeSwitchTitle: '切换到浅色',
    darkModeSwitchTitle: '切换到深色',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    skipToContentLabel: '跳到正文',
    externalLinkIcon: true,

    socialLinks: [{ icon: 'github', link: REPO, ariaLabel: 'infOS 的 GitHub 仓库' }],
    footer: {
      message: '萌动链接：PeroperoChat！由开源项目 infOS 驱动，以 Apache-2.0 许可发布。',
      copyright: 'Let AI become a truly warm companion.',
    },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            displayDetails: '显示详细列表',
            resetButtonTitle: '清除查询',
            backButtonTitle: '关闭搜索',
            noResultsText: '没有找到相关结果',
            footer: {
              selectText: '选择',
              selectKeyAriaLabel: '回车',
              navigateText: '切换',
              navigateUpKeyAriaLabel: '上方向键',
              navigateDownKeyAriaLabel: '下方向键',
              closeText: '关闭',
              closeKeyAriaLabel: 'Esc',
            },
          },
        },
        miniSearch: {
          options: {
            // 中文没有空格分词，用 Intl.Segmenter 切词；该函数会序列化到浏览器端，必须自包含
            tokenize: (text: string) => {
              if (typeof Intl === 'undefined' || !('Segmenter' in Intl)) {
                return text.split(/[\s\p{P}\p{S}]+/u).filter(Boolean)
              }
              const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' })
              const words: string[] = []
              for (const part of segmenter.segment(text)) {
                if (part.isWordLike) words.push(part.segment)
              }
              return words
            },
          },
          searchOptions: { fuzzy: 0.2, prefix: true, boost: { title: 4, text: 2, titles: 1 } },
        },
      },
    },
  },
})

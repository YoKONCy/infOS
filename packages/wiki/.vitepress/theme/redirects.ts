/**
 * 旧页面地址 → 新地址
 *
 * GitHub Pages 对不存在的路径返回 404 页，404 页在浏览器端查这张表再跳转，
 * 让旧链接、搜索引擎收录和 README 外链继续可用。移动或删除页面时同步维护。
 *
 * @module packages/wiki/.vitepress/theme/redirects
 */

const REDIRECTS: Record<string, string> = {
  '/peripheral-systems/dashboard': '/guide/dashboard',
  '/peripheral-systems/conversation-workspace': '/companion/chat',
  '/peripheral-systems/bedrock': '/companion/desktop-pet',
  '/peripheral-systems/character': '/companion/character',
  '/peripheral-systems/stronghold': '/companion/stronghold',
  '/peripheral-systems/social': '/companion/social',
  '/peripheral-systems/browser': '/work/browser',
  '/core-systems/memory': '/companion/memory',
  '/core-systems/tools': '/work/tools',
  '/core-systems/workspace-tasks': '/work/tasks',
  '/core-systems/extensions-apps': '/work/extensions',
  '/core-systems/mdp': '/advanced/prompts',
  '/core-systems/context': '/advanced/context',
  '/core-systems/aios': '/advanced/aios',
  // 已合并到其他页面的旧主题
  '/core-systems/nit': '/work/tools#nit-脚本编排',
  '/core-systems/spreading-activation': '/companion/memory#伙伴怎样想起一件事',
  '/ecosystem/plugins': '/work/extensions#使用插件',
  '/ecosystem/skills-mcp': '/work/extensions#先认识几种扩展方式',
  '/ecosystem/models': '/companion/desktop-pet#模型资源从哪里来',
  '/ecosystem/mobile': '/deployment/distributed#配对其他设备',
  '/ecosystem/extension': '/work/extensions',
  '/ecosystem/workshop': '/companion/desktop-pet#模型资源从哪里来',
  '/ecosystem/mod': '/work/extensions',
  '/ecosystem/social': '/companion/social',
}

/** 根据当前路径（已去掉站点 base）查找新地址；没有对应项时返回 null */
export function findRedirect(pathname: string): string | null {
  let key = pathname
  try {
    key = decodeURI(pathname)
  } catch {
    // 非法编码的地址按原样查找
  }
  key = key.replace(/\.html$/, '').replace(/\/index$/, '').replace(/\/+$/, '')
  return REDIRECTS[key] ?? null
}

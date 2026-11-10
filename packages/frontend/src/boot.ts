/**
 * 渲染进程入口
 *
 * 所有窗口（主界面、启动器、桌宠、通知层等）共用此入口。先装配当前语言词库，
 * 再加载应用模块：模块初始化与首屏渲染读取到的都是已装配的译文，不会闪现原文。
 * 其他语言词库保持独立分块，只在切换语言时加载。
 */
import { loadActiveLocaleCatalogs } from './i18n/index'
import { getLocale } from '@infos/shared/i18n'

async function boot(): Promise<void> {
  for (;;) {
    const language = getLocale()
    await loadActiveLocaleCatalogs()
    // 等待函数返回到入口的微任务间隙也可能收到广播，导入应用前再次确认。
    if (getLocale() !== language) continue
    await import('./main')
    return
  }
}

void boot()

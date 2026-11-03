import { describe, expect, it } from 'vitest'
import {
  createApplicationWaitingContent,
  createApplicationWaitingPage,
} from '../src/applicationWaitingPage'

describe('子应用启动页面的名称转义', () => {
  it('应用名称中的 HTML 不会作为脚本执行', () => {
    const options = {
      dark: false,
      applicationName: '</style><script>窗口</script>',
      motion: 'off' as const,
    }
    const content = createApplicationWaitingContent(options)
    const page = createApplicationWaitingPage(options)
    expect(content).toContain('&lt;script&gt;窗口&lt;/script&gt;')
    expect(page).not.toContain('<script>')
  })
})

import { describe, expect, it } from 'vitest'
import { assetRequestHeaders } from './assetRequestPolicy'

describe('模型资产来源策略', () => {
  const request = (origin?: string, method = 'GET') =>
    new Request('https://model.example/file', {
      method,
      headers: origin ? { Origin: origin } : {},
    })
  it('为正式 file 页面提供明确的 CORS 来源，不开放任意网站', () => {
    expect(assetRequestHeaders(request('null'))?.get('Access-Control-Allow-Origin')).toBe('null')
    expect(assetRequestHeaders(request('https://attacker.example'))).toBeNull()
  })
  it('只允许实际配置的开发来源，端口和来源必须完全匹配', () => {
    const renderer = 'http://localhost:5173/app'
    expect(
      assetRequestHeaders(request('http://localhost:5173'), renderer)?.get(
        'Access-Control-Allow-Origin',
      ),
    ).toBe('http://localhost:5173')
    expect(assetRequestHeaders(request('http://localhost:5174'), renderer)).toBeNull()
    expect(
      assetRequestHeaders(request('http://localhost.attacker.example:5173'), renderer),
    ).toBeNull()
    expect(assetRequestHeaders(request('http://localhost:5173'), 'invalid')).toBeNull()
  })
  it('原生资源请求不添加通配 CORS，拒绝写入与跨来源预检', () => {
    expect(assetRequestHeaders(request())?.has('Access-Control-Allow-Origin')).toBe(false)
    expect(assetRequestHeaders(request('null', 'HEAD'))).not.toBeNull()
    expect(assetRequestHeaders(request('null', 'OPTIONS'))).not.toBeNull()
    expect(assetRequestHeaders(request('null', 'DELETE'))).toBeNull()
    expect(assetRequestHeaders(request('https://attacker.example', 'OPTIONS'))).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import {
  classifyAttachmentUpload,
  MAX_INLINE_ATTACHMENT_IMAGE_BYTES,
  MAX_INLINE_ATTACHMENT_TEXT_BYTES,
} from '../src/attachmentUpload'
describe('原件上传与自动内容装配分别分类', () => {
  it('支持空 MIME 的常用后缀，未知文件只作为原件', () => {
    expect(classifyAttachmentUpload('配置.json', '', 100)).toBe('text')
    expect(classifyAttachmentUpload('图片.PNG', '', 100)).toBe('image')
    expect(classifyAttachmentUpload('资料.pdf', 'application/pdf', 100)).toBe('pdf')
    expect(classifyAttachmentUpload('工具.zip', 'application/zip', 100)).toBe('file')
  })
  it('自动解析的体积上限不再等价于上传失败', () => {
    expect(
      classifyAttachmentUpload('大文本.txt', 'text/plain', MAX_INLINE_ATTACHMENT_TEXT_BYTES + 1),
    ).toBe('file')
    expect(
      classifyAttachmentUpload('大图片.png', 'image/png', MAX_INLINE_ATTACHMENT_IMAGE_BYTES + 1),
    ).toBe('file')
    expect(
      classifyAttachmentUpload(
        '大文档.pdf',
        'application/pdf',
        MAX_INLINE_ATTACHMENT_IMAGE_BYTES + 1,
      ),
    ).toBe('file')
  })
  it('音频归一化常见 MIME 与后缀，声明为视频的 WebM 不误判', () => {
    expect(classifyAttachmentUpload('录音.WAV', '', 100)).toBe('audio')
    expect(classifyAttachmentUpload('录音.m4a', 'audio/mp4', 100)).toBe('audio')
    expect(classifyAttachmentUpload('录音.webm', 'audio/webm;codecs=opus', 100)).toBe('audio')
    expect(classifyAttachmentUpload('视频.webm', 'video/webm', 100)).toBe('file')
  })
})

/** 事件加工与历史草稿恢复共用第一人称开篇校验。 */
export function validateEventNoteNarrative(value: unknown): string {
  const narrative = typeof value === 'string' ? value.trim() : ''
  if (!narrative) throw new Error('事件记叙不能为空')
  if (!/^(?:我|I\b)/u.test(narrative)) {
    throw new Error(
      '事件记叙视角不符合要求：narrative 必须以当前 Agent 自己的第一人称主语开篇，中文以“我”开头，英文以“I”开头。请根据真实对话重写后重新调用工具；他人的经历用“我得知……”或“我听……说……”表述，不要写成自己的亲身经历，也不要机械添加“我”字。',
    )
  }
  return narrative
}

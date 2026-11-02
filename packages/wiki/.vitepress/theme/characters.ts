/**
 * 文档站出场角色
 *
 * 只收录 Pero 与佩诺菈。台词取自角色档案的口吻（packages/backend/src/assets/agents），
 * 只出现在角色气泡里；正文保持平实说明。
 *
 * @module packages/wiki/.vitepress/theme/characters
 */

export type CompanionId = 'pero' | 'penora'

export interface Companion {
  id: CompanionId
  name: string
  /** 小头像（public 下的路径） */
  avatar: string
  /** 阅读陪伴台词：刚开始、读到一半、读完 */
  reading: { start: string[]; middle: string[]; end: string[] }
  /** 点头像时的回应 */
  pokes: string[]
}

export const companions: Record<CompanionId, Companion> = {
  pero: {
    id: 'pero',
    name: 'Pero',
    avatar: '/characters/pero-avatar.webp',
    reading: {
      start: [
        '锵锵！这一页由 Pero 陪你读~',
        '慢慢看就好，Pero 就在旁边。',
        '先挑想看的小节也可以哒。',
      ],
      middle: [
        '读到一半啦，要不要喝口水？',
        '嗯嗯，这里 Pero 也认真记下来了！',
        '加油加油，Pero 给你打气~',
      ],
      end: [
        '读完啦！Pero 给你盖一朵小红花~',
        '这一页完成！要不要去应用里试试看？',
        '辛苦啦，下一页也一起看吗？',
      ],
    },
    pokes: [
      '嘿嘿，摸摸头，智商 +1！Pero 变聪明啦~',
      '哒哒~ Pero 的幸运加持已送达，请查收！',
      '哼哼，你的手指真调皮，Pero 记在小本本上了！',
      '今天的 Pero 也是世界第一可爱哒！不许反驳哦~',
    ],
  },
  penora: {
    id: 'penora',
    name: '佩诺菈',
    avatar: '/characters/penora-avatar.webp',
    reading: {
      start: [
        '这一页由诺菈陪你看，我们一件件来。',
        '唔，先找到想看的小节也可以哦。',
      ],
      middle: [
        '已经看了一半啦，要不要伸个懒腰？',
        '这里有点细，诺菈陪你慢慢看。',
      ],
      end: [
        '看完啦，今天也认真前进了一小步。',
        '嘿嘿，看完这一页，心情都轻快了一点。',
      ],
    },
    pokes: [
      '嗯？诺菈在听呢。',
      '唔，帽子要歪啦……不过，被夸奖一样的感觉，好开心。',
      '嘿嘿，收到你的招呼啦！',
    ],
  },
}

/** 首页按时段问候，改写自 Pero 档案中的时段问候 */
export function peroGreeting(hour: number): string {
  if (hour >= 5 && hour < 8) return '早安！新的一天也要和 Pero 一起元气满满哦！'
  if (hour >= 8 && hour < 11) return '上午好！喝杯咖啡，Pero 会一直陪着你的~'
  if (hour >= 11 && hour < 13) return '午饭时间！先好好吃饭，再来慢慢看文档吧~'
  if (hour >= 13 && hour < 17) return '下午容易犯困呢，Pero 来给你打打气！'
  if (hour >= 17 && hour < 19) return '夕阳好美呀……Pero 最喜欢和你一起看晚霞了。'
  if (hour >= 19 && hour < 23) return '晚上好！今天辛苦啦，想先看哪一部分呢？'
  return '夜猫子模式启动！Pero 陪着你，不过不许熬太晚哦~'
}

/** 从列表中取一句与上一句不同的台词 */
export function pickLine(lines: string[], previous?: string): string {
  if (lines.length <= 1) return lines[0] ?? ''
  let next = previous
  while (next === previous) next = lines[Math.floor(Math.random() * lines.length)]
  return next as string
}

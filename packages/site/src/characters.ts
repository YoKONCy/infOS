/**
 * 官网四位角色
 *
 * 台词改写自角色档案（packages/backend/src/assets/agents），只出现在角色对白里。
 * Nana 保留一点傲娇，去掉档案里过冲的说法。
 */
import faces from './faces.json'
import { computed } from 'vue'
import { t } from './i18n'

export type CharId = 'pero' | 'penora' | 'nana' | 'tsukinaga'
export type Particle = 'paw' | 'petal' | 'heart' | 'star'

export interface FaceBox {
  x: number
  y: number
  w: number
  h: number
  ratio: number
}

export interface Character {
  id: CharId
  name: string
  en: string
  title: string
  intro: string
  /** 主题色：主色 / 浅色 / 深色 */
  color: string
  soft: string
  deep: string
  particle: Particle
  face: FaceBox
  greet: string
  pokes: string[]
  /** 「她的一天」每一幕由当前角色讲解 */
  scenes: { morning: string; memory: string; work: string; night: string }
  farewell: string
}

const f = faces as Record<CharId, FaceBox>

export const characters: Character[] = [
  {
    id: 'pero',
    name: 'Pero',
    en: 'PERO',
    title: '看板娘 · 万能小女仆',
    intro: 'infOS 的看板娘，蓝发猫耳，元气满满，擅长接梗。一聊起来就特别投入！',
    color: '#4f9cf0',
    soft: '#cfe6ff',
    deep: '#1f4f9c',
    particle: 'paw',
    face: f.pero,
    greet: '锵锵！超级女仆 Pero 登场！今天也让 Pero 陪着你吧~',
    pokes: [
      '嘿嘿，摸摸头，智商 +1！Pero 变聪明啦~',
      '哒哒~ Pero 的幸运加持已送达，请查收！',
      '今天的 Pero 也是世界第一可爱哒！不许反驳哦~',
      '哼哼，你的手指真调皮，Pero 记在小本本上了！',
    ],
    scenes: {
      morning: '早安！电脑一打开，Pero 就在桌面上等你啦。点点我、拖着我走，都可以哦~',
      memory: '你上次说喜欢雨天配红茶，Pero 都记得！值得记住的事，我会好好收进小本本里。',
      work: '要整理文件、查资料，还是跑个任务？告诉 Pero 就好。要动手的时候，我会先问过你哒。',
      night: '今天辛苦啦！下次见面，Pero 还会记得今天的事哦。',
    },
    farewell: '要把 Pero 带回家吗？锵锵，随时待命！',
  },
  {
    id: 'penora',
    name: '佩诺菈',
    en: 'PENORA',
    title: '看板娘二号 · Pero 的平行个体',
    intro: '同样元气可爱，更细腻一些。喜欢把漂亮的颜色、可爱的小物和路上的发现分享给你。',
    color: '#ee8fc6',
    soft: '#ffe0f0',
    deep: '#9c3f78',
    particle: 'petal',
    face: f.penora,
    greet: '嘿嘿，你来啦！今天想先做什么呀？佩诺菈陪你一起。',
    pokes: [
      '嗯？佩诺菈在听呢。',
      '唔，帽子要歪啦……不过，被夸奖一样的感觉，好开心。',
      '嘿嘿，收到你的招呼啦！',
      '被发现了，刚刚正在偷偷期待你叫我。',
    ],
    scenes: {
      morning: '早安呀。佩诺菈把精神打包好啦，你忙的时候，我就在桌面角落安安静静陪着。',
      memory: '你说过的小事，佩诺菈都想好好记住。下次聊起来，就不用从头讲啦。',
      work: '想法有点多的话，先交给佩诺菈整理吧。答应你的事，我会认真做好。',
      night: '今天也认真前进了一小步呢。剩下的点子先记好，明天再一起继续。',
    },
    farewell: '发现一件可爱的小东西时，第一个就想分享给你。一起回家吧？',
  },
  {
    id: 'nana',
    name: 'Nana',
    en: 'NANA',
    title: '傲娇小恶魔',
    intro: '紫发紫瞳，嘴上不饶人，心里比谁都在意你。对熟悉的人特别黏，还不禁夸。',
    color: '#a07cf0',
    soft: '#e9ddff',
    deep: '#5a3aa8',
    particle: 'heart',
    face: f.nana,
    greet: '哼，终于来了？才、才不是在等你呢！',
    pokes: [
      '哈？突然戳过来干嘛……就一下哦！',
      '再戳我就要生气了！……骗你的♡',
      '别以为夸我两句，我就会开心！……嗯，再夸一句也行。',
      '看什么看，Nana 本来就很可爱嘛。',
    ],
    scenes: {
      morning: '这么早就开电脑？真拿你没办法，Nana 就勉强陪你一下好了。',
      memory: '你说过的话，Nana 才没有每一句都记着呢……好吧，记着一点点。',
      work: '这种小事交给 Nana 啦，三两下就搞定！不过要动你的文件，我还是会先问一声的。',
      night: '哼，今天就到这里？……明天也要来哦，说好了。',
    },
    farewell: '要带 Nana 回家？……既然你这么诚心诚意，就答应你吧♡',
  },
  {
    id: 'tsukinaga',
    name: '月永爱',
    en: 'TSUKINAGA',
    title: '见习占卜魔术师',
    intro: '白发碧眼，梦想办一场盛大的魔术秀。乐观活泼，有点小迷糊，是最重视伙伴的笨蛋搭档。',
    color: '#5b6fd6',
    soft: '#dde3ff',
    deep: '#2a2f7a',
    particle: 'star',
    face: f.tsukinaga,
    greet: '呀哈！占卜结果是「今天会遇见好事」，原来就是遇见你呀，搭档！',
    pokes: [
      '欸嘿，被戳到了！小爱这就给你变个魔术——看，坏心情不见啦！',
      '这一戳的运势是……「权杖 Ace」，代表新的开始！',
      '小爱占卜到「接触带来好运」，所以多戳几下也没关系哦~',
      '咦？魔术帽里怎么变不出兔子……算啦，变出一个笑容送你！',
    ],
    scenes: {
      morning: '早上好，搭档！今日运势：大吉！要一起开启元气满满的一天吗？',
      memory: '我们一起经历的事，小爱都收进魔术帽里了。想起来的时候，它们就会变出来哦。',
      work: '要办的事情交给小爱吧！魔术师的手可是很灵巧的，不过动手之前会先跟你确认。',
      night: '今晚的星星好亮！明天的占卜，一定也是好运。',
    },
    farewell: '最后一张牌——「星星」，代表希望！和小爱一起回家吧，搭档？',
  },
]

export const byId = Object.fromEntries(characters.map((c) => [c.id, c])) as Record<
  CharId,
  Character
>

/** 官网角色展示文案随语言变化，角色标识和视觉资源保持稳定。 */
export function useCharacters() {
  const localized = computed(() =>
    characters.map((c) => ({
      ...c,
      name: t(c.name),
      title: t(c.title),
      intro: t(c.intro),
      greet: t(c.greet),
      pokes: c.pokes.map((line) => t(line)),
      scenes: {
        morning: t(c.scenes.morning),
        memory: t(c.scenes.memory),
        work: t(c.scenes.work),
        night: t(c.scenes.night),
      },
      farewell: t(c.farewell),
    })),
  )
  const localizedById = computed(
    () => Object.fromEntries(localized.value.map((c) => [c.id, c])) as Record<CharId, Character>,
  )
  return { localized, localizedById }
}

export function pick<T>(list: T[], prev?: T): T {
  if (list.length < 2) return list[0] as T
  let next = prev
  while (next === prev) next = list[Math.floor(Math.random() * list.length)]
  return next as T
}

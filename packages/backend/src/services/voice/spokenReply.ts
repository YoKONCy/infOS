/** 保留标点和模型控制标记，避免破坏发音、停顿及括号指令。 */
export function prepareTtsText(text: string): string {
  return text
    .replace(
      /<(selfMinding|think|thinking|thought|plan|action|observation)\b[^>]*>[\s\S]*?<\/\1>/gi,
      '',
    )
    .replace(/<(selfMinding|think|thinking|thought)\b[^>]*>[\s\S]*$/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(https?:[^)]*\)/g, '$1')
    .trim()
}

/** 清洗仅作用于独立口语答复，不能用完整回复作为缺省输入。 */
export function cleanTextForTts(text: string): string {
  return text
    .replace(
      /<(selfMinding|think|thinking|thought|plan|action|observation)\b[^>]*>[\s\S]*?<\/\1>/gi,
      '',
    )
    .replace(/<(selfMinding|think|thinking|thought)\b[^>]*>[\s\S]*$/gi, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(
      /\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic})*/gu,
      '',
    )
    .replace(/[\p{Regional_Indicator}\p{Emoji_Modifier}]/gu, '')
    .replace(/[0-9#*]\uFE0F?\u20E3/g, '')
    .replace(/([0-9])\.(?=[0-9])/g, '$1点')
    .replace(/(\d+(?:点\d+)?)\s*[%％]/g, '百分之$1')
    .replace(/([0-9])\s*[-–—]\s*(?=[0-9])/g, '$1至')
    .replace(/(^|[^0-9])[-−](?=\d)/g, '$1负')
    .replace(/℃|°\s*C\b/gi, '摄氏度')
    .replace(/(\d)\s*kg\b/gi, '$1千克')
    .replace(/(\d)\s*km\b/gi, '$1千米')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/(?:[\u200B-\u200F]|\uFE0E|\uFE0F|\u20E3)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

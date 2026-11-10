/** 普通聊天、stop_speech 与陪看共用代次；用户聊天会抢占低优先级合成。 */
export const speechGenerations = new Map<string, number>()
export const speechControllers = new Map<string, AbortController>()

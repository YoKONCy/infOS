/** 逻辑超时只回收等待边界，不能隔离任意 Node 原生代码。 */
export async function packageTimeout<T>(operation: Promise<T>, timeoutMs = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('PACKAGE_CALLBACK_TIMEOUT')), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

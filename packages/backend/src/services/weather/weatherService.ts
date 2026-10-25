import { z } from 'zod'
import type { WeatherKind, WeatherSnapshot, WeatherStatus } from '@infos/shared'
import type { ConfigRepository } from '../../repositories/config.repo'
import { AppError } from '../../lib/appError'

const REFRESH_MS = 30 * 60_000
const MAX_AGE_MS = 2 * 60 * 60_000
const RETRY_MS = 5 * 60_000
const CONFIG_KEY = 'weather.default'
const CACHE_VERSION = 1
const numeric = z.string().trim().min(1).transform(Number).pipe(z.number().finite())
const currentSchema = z.object({
  temp_C: numeric,
  FeelsLikeC: numeric,
  humidity: numeric.pipe(z.number().min(0).max(100)),
  windspeedKmph: numeric.pipe(z.number().nonnegative()),
  weatherCode: z.string().trim(),
  observation_time: z.string().max(80),
})
const responseSchema = z.object({
  current_condition: z.array(currentSchema).min(1),
  nearest_area: z
    .array(
      z.object({
        areaName: z.array(z.object({ value: z.string() })).min(1),
        latitude: numeric.pipe(z.number().min(-90).max(90)),
        longitude: numeric.pipe(z.number().min(-180).max(180)),
      }),
    )
    .min(1),
  weather: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        mintempC: numeric,
        maxtempC: numeric,
        hourly: z
          .array(z.object({ time: numeric, weatherCode: z.string().trim(), chanceofrain: numeric }))
          .min(1),
      }),
    )
    .min(1)
    .max(10),
})

const kindSchema = z.enum(['sun', 'cloud', 'rain', 'snow', 'thunder', 'mist'])
const snapshotSchema = z.object({
  query: z.string().max(80),
  location: z.string().max(80),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  temperature: z.number().finite(),
  feelsLike: z.number().finite(),
  humidity: z.number().min(0).max(100),
  windKmh: z.number().finite().nonnegative(),
  condition: z.string().max(30),
  kind: kindSchema,
  observedTime: z.string().max(80),
  fetchedAt: z.string().datetime(),
  source: z.literal('wttr.in'),
  days: z
    .array(
      z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        low: z.number().finite(),
        high: z.number().finite(),
        condition: z.string().max(30),
        kind: kindSchema,
        rainChance: z.number().min(0).max(100).nullable(),
      }),
    )
    .min(1)
    .max(3),
})

// 上游完整代码表：https://www.worldweatheronline.com/feed/wwoConditionCodes.txt
const atmosphericConditions: Record<string, string> = {
  '125': '霾',
  '128': '沙尘霾',
  '131': '扬尘',
  '134': '尘暴',
  '137': '沙尘暴',
  '140': '强沙尘暴',
  '146': '烟尘',
  '149': '烟霾',
  '152': '雾霾',
  '155': '严重雾霾',
  '158': '沙尘',
  '161': '浮尘',
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function condition(code: string): { condition: string; kind: WeatherKind } {
  const atmospheric = atmosphericConditions[code]
  if (atmospheric) return { condition: atmospheric, kind: 'mist' }
  if (code === '113') return { condition: '晴', kind: 'sun' }
  if (code === '116') return { condition: '局部多云', kind: 'cloud' }
  if (code === '119') return { condition: '多云', kind: 'cloud' }
  if (code === '122') return { condition: '阴', kind: 'cloud' }
  if (['143', '248', '260'].includes(code)) return { condition: '雾', kind: 'mist' }
  if (['200', '386', '389', '392', '395'].includes(code))
    return { condition: '雷阵雨', kind: 'thunder' }
  if (
    [
      '179',
      '182',
      '185',
      '227',
      '230',
      '281',
      '284',
      '311',
      '314',
      '317',
      '320',
      '323',
      '326',
      '329',
      '332',
      '335',
      '338',
      '350',
      '362',
      '365',
      '368',
      '371',
      '374',
      '377',
    ].includes(code)
  )
    return { condition: '雨雪或冰冻降水', kind: 'snow' }
  if (
    ['176', '263', '266', '293', '296', '299', '302', '305', '308', '353', '356', '359'].includes(
      code,
    )
  )
    return { condition: '雨', kind: 'rain' }
  return { condition: '天气不详', kind: 'cloud' }
}

export function normalizeWeatherLocation(value: string): string {
  const query = value.replace(/[\r\n\t]/g, ' ').trim()
  // eslint-disable-next-line no-control-regex -- 城市查询拒绝 ASCII 控制字符。
  if (!query || query.length > 80 || /[\x00-\x1f\x7f]/.test(query) || !/[\p{L}\p{N}]/u.test(query))
    throw new AppError('INVALID_PARAMETER', { message: '请输入城市、区县或经纬度，最多 80 个字符' })
  return query
}

/** 卡片、提示词与查询工具共用缓存；对话编译不等待网络。 */
export class WeatherService {
  private defaultQuery = ''
  private cache = new Map<string, WeatherSnapshot>()
  private pending = new Map<string, Promise<WeatherSnapshot>>()
  private failures = new Map<string, { until: number; message: string }>()
  private timer?: ReturnType<typeof setInterval>
  private controller = new AbortController()
  private locationRevision = 0

  constructor(private config: ConfigRepository) {}

  async initialize(): Promise<void> {
    const saved = await this.config.getJson<{
      query?: string
      snapshot?: WeatherSnapshot
      version?: number
    }>(CONFIG_KEY)
    if (saved?.query) {
      try {
        this.defaultQuery = normalizeWeatherLocation(saved.query)
        const snapshot = snapshotSchema.safeParse(saved.snapshot)
        // 旧缓存只保存了映射文案，无法重新解析天气代码，需要重新获取。
        if (
          saved.version === CACHE_VERSION &&
          snapshot.success &&
          snapshot.data.query === this.defaultQuery
        )
          this.cache.set(this.defaultQuery, snapshot.data)
      } catch {
        /* 无效的旧位置留待用户重新设置。 */
      }
    }
    this.refreshDefault()
    this.timer = setInterval(() => this.refreshDefault(), 60_000)
    this.timer.unref()
  }

  dispose(): void {
    clearInterval(this.timer)
    this.controller.abort()
  }

  private fresh(snapshot: WeatherSnapshot, age = REFRESH_MS): boolean {
    const now = new Date()
    const fetchedAt = new Date(snapshot.fetchedAt)
    const elapsed = now.getTime() - fetchedAt.getTime()
    return elapsed >= 0 && elapsed < age && localDateKey(fetchedAt) === localDateKey(now)
  }

  private refreshDefault(): void {
    if (this.defaultQuery) void this.query(this.defaultQuery).catch(() => undefined)
  }

  getStatus(): WeatherStatus {
    const snapshot = this.cache.get(this.defaultQuery) ?? null
    return {
      query: this.defaultQuery,
      snapshot,
      refreshing: this.pending.has(this.defaultQuery),
      stale: snapshot ? !this.fresh(snapshot, MAX_AGE_MS) : false,
      error: this.failures.get(this.defaultQuery)?.message ?? null,
    }
  }

  /** 只输出已映射的天气文案及数值，避免把上游自由文本当作提示词。 */
  promptFields(): { weather_location: string; weather_info: string } {
    const { snapshot, stale } = this.getStatus()
    if (!snapshot) return { weather_location: this.defaultQuery, weather_info: '' }
    if (stale) return { weather_location: this.defaultQuery, weather_info: '' }
    const day = snapshot.days.find((item) => item.date === localDateKey(new Date()))
    const range = day ? `；${day.date} ${day.low}～${day.high}°C` : ''
    const rain = day?.rainChance != null ? `，最高降水概率${day.rainChance}%` : ''
    return {
      weather_location: `${snapshot.query}（匹配：${snapshot.location}）`,
      weather_info: `${snapshot.condition}，${snapshot.temperature}°C，体感${snapshot.feelsLike}°C${range}${rain}；获取于${snapshot.fetchedAt}，来源 wttr.in`,
    }
  }

  async setLocation(value: string): Promise<WeatherStatus> {
    const query = value.trim() ? normalizeWeatherLocation(value) : ''
    const revision = ++this.locationRevision
    const snapshot = query ? await this.query(query) : null
    if (revision !== this.locationRevision)
      throw new AppError('CONFLICT', { message: '城市设置已被后续操作替代' })
    const previous = this.defaultQuery
    this.defaultQuery = query
    try {
      await this.config.setJson(CONFIG_KEY, { version: CACHE_VERSION, query, snapshot })
    } catch (error) {
      if (revision === this.locationRevision) this.defaultQuery = previous
      throw error
    }
    return this.getStatus()
  }

  async query(value?: string): Promise<WeatherSnapshot> {
    this.controller.signal.throwIfAborted()
    const query = normalizeWeatherLocation(value || this.defaultQuery)
    const cached = this.cache.get(query)
    if (cached && this.fresh(cached)) return cached
    const pending = this.pending.get(query)
    if (pending) return pending
    const failed = this.failures.get(query)
    if (failed && failed.until > Date.now())
      throw new AppError('SERVICE_UNAVAILABLE', { message: failed.message })
    if (this.pending.size >= 8)
      throw new AppError('SERVICE_UNAVAILABLE', { message: '天气查询较多，请稍后重试' })
    const request = this.fetchWeather(query)
      .then(async (snapshot) => {
        this.controller.signal.throwIfAborted()
        this.cache.delete(query)
        this.cache.set(query, snapshot)
        // 保留默认城市，限制临时查询占用的内存。
        for (const key of this.cache.keys()) {
          if (this.cache.size <= 24) break
          if (key !== this.defaultQuery) this.cache.delete(key)
        }
        this.failures.delete(query)
        if (this.defaultQuery === query && !this.controller.signal.aborted)
          await this.config.setJson(CONFIG_KEY, { version: CACHE_VERSION, query, snapshot })
        return snapshot
      })
      .catch(() => {
        const message = '天气暂时无法更新，请稍后重试'
        this.failures.set(query, { until: Date.now() + RETRY_MS, message })
        if (this.failures.size > 24) {
          const first = this.failures.keys().next().value
          if (first !== undefined) this.failures.delete(first)
        }
        throw new AppError('SERVICE_UNAVAILABLE', { message })
      })
      .finally(() => {
        this.pending.delete(query)
      })
    this.pending.set(query, request)
    return request
  }

  private async fetchWeather(query: string): Promise<WeatherSnapshot> {
    const url = new URL(`https://wttr.in/${encodeURIComponent(query)}`)
    // j1 的逐小时数据只在服务端用于计算每日降水概率，不原样回交模型。
    url.searchParams.set('format', 'j1')
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'infOS/0.9.6 (+https://github.com/YoKONCy/infOS)',
        Accept: 'application/json',
      },
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(12_000)]),
      redirect: 'error',
    })
    if (!response.ok) throw new Error('天气服务响应异常')
    const text = await response.text()
    if (text.length > 512_000) throw new Error('天气响应过大')
    const raw = responseSchema.parse(JSON.parse(text))
    const current = raw.current_condition[0]!
    const area = raw.nearest_area[0]!
    return {
      query,
      // eslint-disable-next-line no-control-regex -- 外部地点名称清理 ASCII 控制字符。
      location: area.areaName[0]!.value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 80),
      latitude: area.latitude,
      longitude: area.longitude,
      temperature: current.temp_C,
      feelsLike: current.FeelsLikeC,
      humidity: current.humidity,
      windKmh: current.windspeedKmph,
      ...condition(current.weatherCode),
      observedTime: current.observation_time,
      fetchedAt: new Date().toISOString(),
      source: 'wttr.in',
      days: [...raw.weather]
        .sort((a, b) => a.date.localeCompare(b.date))
        .slice(0, 3)
        .map((day) => {
          const noon = day.hourly.reduce((a, b) =>
            Math.abs(a.time - 1200) < Math.abs(b.time - 1200) ? a : b,
          )
          return {
            date: day.date,
            low: day.mintempC,
            high: day.maxtempC,
            ...condition(noon.weatherCode),
            rainChance: Math.max(0, Math.min(100, ...day.hourly.map((hour) => hour.chanceofrain))),
          }
        }),
    }
  }
}

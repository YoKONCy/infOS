# 天气

## 使用

在「系统设定」或天气卡片中设置城市、区县或纬度经度，例如 `上海`、`上海杨浦`、`31.23,121.47`。保存前查询一次，成功后保存默认地点及匹配坐标。清除地点后停止后台天气请求。

总览页与新标签页显示同一个天气卡片组件：当前温度、天气、日温度范围和最高降水概率。点击摘要可展开体感、湿度、风速、三日预报、匹配地点和数据时间。未配置时显示设置入口；更新失败保留已有数据并提示，超过两小时标记过期。

## 数据与生命周期

- 来源为 wttr.in，无需 API Key。服务端使用 j1 的逐小时数据计算每日最高降水概率，向前端返回精简结构。
- 默认地点和最后成功快照存于现有 configs 表的 `weather.default`，作为配置与缓存保存，不创建独立天气实体。
- 启动先读取缓存，再异步更新；默认每 30 分钟刷新。相同地点的并发请求合并，失败后等待 5 分钟重试，单次上游请求限时 12 秒。
- 临时地点缓存最多 24 项，并发上游查询最多 8 项。临时查询不修改默认地点。关闭服务时清理定时器并取消网络请求。
- 前端多个卡片共用状态和缓存读取轮询，页面隐藏时暂停轮询；关闭最后一个卡片时释放轮询。
- 上游地点匹配可能不是用户预期的区县，可展开检查并改用更完整地名或坐标。观测时间可能缺少日期和时区，获取时间不能视为观测时间。

## 接口

- `GET /api/system/weather`：返回默认地点的缓存状态，不等待上游网络。
- `PUT /api/system/weather/location`：`{ "location": "上海" }`；空字符串清除默认地点。
- 天气由后台自动获取并注入上下文，不提供模型查询工具。

## 上下文与排障

主 ContextCompiler 的 `buildStateSection` 读取 WeatherService 内存快照，产生 weather_location / weather_info，不在编译提示词时访问网络。`services/mdp/prompts/slots/800_pet_state.md` 将其置于 `<Current_Status>`；未配置地点时省略相关字段，不可用或超过两小时的天气不注入。

天气注明获取时间、来源和预报日期，不进入长期记忆。是否存在状态字段取决于调用方传入的变量，不能因共享模板就认为社交 Compiler 自动读取桌面天气或角色状态。社交编排见 [B21](./B21_SOCIAL_CAPABILITIES.md)。

服务入口为 `packages/backend/src/services/weather/weatherService.ts`，卡片为 `packages/frontend/src/components/weather/WeatherCard.vue`，注入入口为 `packages/backend/src/services/context/contextCompiler.ts`。排查“卡片有数据但模型没有天气”时，依次检查快照时效、编译变量和当前生效模板；不要为此在编译热路径增加网络请求。

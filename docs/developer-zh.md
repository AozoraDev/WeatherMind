# WeatherMind 模块开发文档

本文档按模块罗列每个文件的作用、关键方法/函数及其用途，供人查阅。
与 `quickstart-zh.md`（整体流程）互补：这里是「文件级地图」，那里是「核心链路」。

> 维护约定：代码变动需同步更新本文档（见 `.claude/rules/docs-sync.md`）。agent 请勿把本文档当作编码依据。

---

## 0. 总览

```
app/[locale]/          页面（zh 默认无前缀 / en 走 /en）
app/api/ai-agent/       Route Handler（/api 不走 proxy，自带鉴权）
components/             组件（dashboard/auth/notlogin/ui-preset/ui）
hooks/                  React hooks（流式预报 / 模型配置 / 元素高度）
i18n/                   next-intl 路由与消息
lib/weather/            天气采集管道（providers → http → pipeline → 落库）
lib/forecast-agent/     确定性集成引擎 + AI 解读（ReAct 流式）
lib/schemas/            Zod 信任边界 schema（前后端共用）
lib/model-config.ts     AI 模型配置（localStorage 按邮箱隔离）
supabase/               Supabase 客户端（会话/受信写/代理刷新）与认证动作
supabase/migrations/    数据库迁移（0001~0012）
scripts/weather-cron.ts GitHub Actions 每日采集入口
proxy.ts                根中间件（intl 协商 + 会话刷新 + 路由守卫）
```

---

## 1. `lib/weather/` — 天气采集管道

多源（Open-Meteo / OpenWeatherMap / WeatherAPI.com）采集 → 归一化 → 落库。核心入口 `runWeatherPipeline` / `runWeatherBackfill`。

### `http.ts` — 唯一网络封装
全项目天气/模型请求只走这里的 fetch 封装，不引 axios/ky。
- `fetchJson(url, init?, timeoutMs?)` — 拉取并解析 JSON；网络异常归 `network`、非 2xx 归 `http`，**绝不抛错**；`no-store` 禁缓存，可选 `AbortSignal.timeout` 限时
- `fetchStream(url, init?, timeoutMs?)` — 流式 fetch（AI/SSE 场景），不读 body；`redirect:"manual"` 禁跟随重定向（SSRF 防护）；body 缺失归 `network`

### `pipeline.ts` — 采集管道主流程
- `runWeatherPipeline(trigger)` — 主入口：读启用城市 × 每源并发拉取→落库→清理 7 天前快照→写 `weather_runs`；单格失败隔离、整轮永不抛错，返回 `RunSummary`
- `runWeatherBackfill(days)` — 历史回填：只写 `weather_daily`（temperature 取高低温均值）、按城市时区窗口过滤、不做窗口清理
- 内部：`writeCell`（实时+每日快照 upsert）、`writeDailyRow`（当日快照，预报缺当天 slot 时用实时兜底）、`writeBackfillDay`、`cleanupAfterRun`（清理 7 天前）、`openRun`/`finalizeRun`（运行记录）
- 类型：`RunSummary`、`RunStatus`（success/partial/failed）、`CellError`

### `daily.ts` — 城市时区日期工具（纯函数）
- `toLocalDateKey(iso, timeZone)` — UTC ISO → 指定时区本地 `YYYY-MM-DD`（`Intl.formatToParts` 实现，跨环境稳定）
- `aggregateDailyForecast(timeZone, forecast)` — 预报 slot 按城市本地日分桶聚合（高/低/降水，condition 取最高温 slot）
- `todayAggregate(timeZone, fetchedAt, forecast, current)` — 当日快照聚合，预报缺当天 slot 时用实时数据兜底
- `daysAgoLocalDateKey(timeZone, days, now?)` / `recentWindow(timeZone, days, now?)` — 距今 N 天本地日期键 / 回填窗口

### `mapping.ts` — 条件码 → 归一粗分类（纯函数）
- `mapWmoCode(code)` — Open-Meteo/WMO 码 → `clear/partlyCloudy/cloudy/fog/rain/snow/storm/other`
- `mapOwmCode(code)` — OpenWeatherMap 码（按 id 前缀分区）
- `mapWeatherApiCode(code)` — WeatherAPI.com 码（枚举表粗分）
- `kphToMps(kph)` — WeatherAPI 风速 km/h → m/s

### `view-types.ts` — 展示层 DB 行类型
仅类型，无运行逻辑。定义 `CityRow`/`CurrentRow`/`DailyRow`/`RunRow`/`TruthRow`（snake_case，对应迁移表结构），`ForecastRow` re-export 自 `schemas/forecast-agent.ts`（单一来源防漂移）。

### `resolve-city.ts` — 城市参数解析（服务端）
- `resolveCityParam(cities, rawCity, pathname)` — 解析 `?city=` 为唯一城市：name_en 不区分大小写匹配，回退东京再退第一个；缺失/无效时 `redirect` 补齐规范 URL

### `actions.ts` — 手动触发 Server Actions（"use server"）
- `refreshWeatherAction()` — 管理员手动刷新，跑全量管道返回摘要
- `backfillWeatherAction(days=7)` — 管理员手动回填，days 钳制 1~30
- 均先 `getUser` + `isAdminEmail` 白名单，失败返回受限错误码不抛错

### `city-actions.ts` — 城市增删 Server Actions（"use server"）
- `createCityAction(values)` — schema 先验 → 管理员门禁 → service 客户端写入；唯一冲突映射 `duplicate`
- `deleteCityAction(values)` — 硬删，FK cascade 清该城天气；删 0 行映射 `notFound`
- 内部 `requireAdmin()` — 会话 + 白名单门禁

### `admin.ts` — 管理员白名单
- 常量 `ADMIN_EMAIL`；`isAdminEmail(email)` — 小写去空格比较

### `errors.ts` — 受限错误码
- 类型 `WeatherErrorCode` / `CityErrorCode`；类 `WeatherError` / `CityError`（携带 `code` 供客户端取 i18n 文案）

### `sse.ts` — SSE 帧解析纯函数
- `splitSseEvents(buffer)` — 按 `\n\n` 切完整事件块（容错 `\r\n`），返回 `{blocks, rest}`
- `extractDataPayloads(block)` — 剥 `data:` 壳取 payload，支持多行 data
- `isDonePayload(payload)` — 判 `[DONE]` 哨兵

### `providers/index.ts` — 适配器契约与注册表
- 类型 `ProviderAdapter`（`source`/`fetchCurrentAndForecast`/`fetchDailyHistory`）、`AdapterErrorCode`、`HistoryDay`
- 常量 `providers` = [openMeteo, openWeather, weatherApi]；新增源实现契约并注册即可

### `providers/open-meteo.ts` — Open-Meteo 适配器
免 key、单次调用 current+hourly。内部：`toUtcIso`（naive 本地时间按偏移转 UTC，不依赖运行环境时区）、`mapCurrentPoint`/`mapForecastItems`（缺必需字段跳过/置 null）、`buildParams`；`fetchDailyHistory` 用 `past_days` 拉回历史逐小时再按日聚合。

### `providers/openweather.ts` — OpenWeatherMap 适配器
实时 `/weather` + 预报 `/forecast` 并行请求（units=metric）；历史回填用 One Call 3.0 `day_summary` 逐天查（该端点无天气状况，condition* 置 null）。

### `providers/weatherapi.ts` — WeatherAPI.com 适配器
实时 `/current` + 预报 `/forecast(days=3)` 并行请求；风速 km/h 转 m/s；历史用 `history.json` 逐天查，day 取请求传入的本地日期键（不信任源 naive 日期）。

---

## 2. `lib/forecast-agent/` — 确定性集成 + AI 解读

「先算后讲」：`engine/` 是纯函数数学内核（可复现、可单测），`agent/` 是受限只读 ReAct 循环，`stream/` 是流式编排，`db/` 是持久化原语。天气数值一律由内核产出，AI 只把指标翻译成自然语言，从根上无法编造数字。

### `stream/stream.ts` — 流式编排（唯一生成入口）
- `runForecastAgentStream(session, service, params)` — AsyncGenerator 产出 `ForecastAgentStreamEvent`：
  读既有→success/pending 直接 `duplicate`；failed 走 5 分钟冷却判定后重试；`claimPending` 认领唯一键 城×日×语言 → `predict` 集成 → 流式 ReAct → `validateMarkdownDoc` 轻量校验 → `settleRow` 落库。
  事件类型：`status`（阶段）/`delta`（Markdown 增量）/`thought`/`rollback`/`tool`/`duplicate`/`done`/`error`。
  生成期失败统一落库 failed + `failed_at`；断线由 finally 兜底清理 pending 行。

### `agent/chat.ts` — OpenAI 兼容 chat 共享原语
- `assertPublicBaseUrl(baseUrl)` — SSRF 前置（字面量白名单 + DNS 复核），返回错误码或 null
- `buildChatRequestBody(params, stream)` — wire 请求体（`temperature:0`、可选 tools、stream 标志）
- `toWireMessage`/`toWireTool` — 内部消息/工具 → OpenAI wire 形态
- `parseChatMessage(msg)` — wire 响应扁平化为 `{content, toolCalls}`
- 类型：`ChatMessage`（system/user/assistant/tool）、`ChatTool`、`ProviderErrorCode`

### `agent/chat-stream.ts` — 流式 chat 调用
- `chatCompletionStream(params, opts?)` — 与 chat 同一 SSRF 前置；按 Content-Type 分发：SSE 流 / `application/json` 单帧降级 / 其余 parse。产出 `ChatStreamEvent`（`delta`/`tool`/`done`）
- 内部 `readSseChatStream` — 逐块读上游流、tool_calls 按 index 累计、usage 从任意帧取；坏帧静默跳过；reader 提前 cancel 关流

### `agent/react.ts` — ReAct 共享内核
- `safeParseJson(s)` — JSON.parse 严格封装
- `mergeUsage(a, b)` — 跨步 usage 累计
- `executeToolCalls(tools, toolCalls)` — 执行工具调用并构造 tool 消息；坏调用不中止（错误观察喂回模型自纠错）
- 类型：`ReactTool`/`ReactAction`/`ReactTrace`/`ReactLoopResult`

### `agent/react-stream.ts` — 流式 ReAct 循环
- `runReActLoopStream(params)` — 循环至多 `maxSteps`（默认 4）：每步调 chat 流、delta 即时透传、工具步发 `thought`+`rollback`（思考文字回滚出正文）+`tool`（间隔展示），步序 `onTrace` 回调写实时轨迹；最终步无工具调用 → `result`（含 content/usage/trace）。步数耗尽/空响应归 `react-loop`，断流归 `network`

### `agent/tools.ts` — ReAct 工具注册表
- `buildTools({result, locale})` — 两个只读工具：
  - `query_source(source)` — 回读某源原始预报快照（核对分歧用）
  - `get_metric(metricId)` — 回读平台指标权威值（metricId 枚举取自 `METRICS` 常量）
  - 参数校验 JSON-schema 与 execute 内 zod 校验器同形；工具描述跟随 locale

### `agent/prompt.ts` — AI 提示词组装
- `buildForecastAgentMessages(city, day, result, locale)` — system+user 消息；指标表只放权威值、源快照不内联（必须调 query_source）；分歧时注入强制核对指令；整份上下文按语言输出
- `formatMetricValue(locale, result, metricId)` — 指标值唯一格式化来源（提示词与 get_metric 共用）
- `metricMeta(locale)` — 指标 label/note 元数据
- 常量 `METRIC_ROW_IDS` — 指标表顺序单一来源

### `agent/prompt-text.ts` — 提示词本地化文案表
- 常量 `TEXTS` — zh/en 两套文案（指标表模板、条件/等级/可信度标签、风险行、分歧块模板），占位符 `{key}` 由 prompt.ts 的 fill 替换
- 类型 `LocaleText` / `MetricMeta`

### `agent/ssrf.ts` — SSRF 防护（纯函数）
- `isAllowedBaseUrl(url)` — 仅 https + host 不在私网/保留名单
- `isPrivateHost(host)` — IPv4/IPv6 字面量私网判定（含内嵌 IPv4 映射、6to4、ULA、link-local 等）、`.local`/`.internal` 保留 TLD
- `hostResolvesToPublic(host)` — 解析出的全部 A/AAAA 必须公网，防「公共域名解析到内网」

### `agent/dns.ts` — DNS 解析隔离
- `resolveHostAll(host)` — 包一层 `node:dns/promises.lookup({all:true})`；测试可 `vi.mock("./dns")`

### `engine/ensemble.ts` — 确定性集成引擎（纯函数）
- `predict(inputs, weights)` — 主入口：加权均值（高/低/降水/风/湿度）→ poP → 条件投票 → 蒲福风级 → 预测区间 → 置信度 → 风险标记 → 完整 `PredictionResult`
- 子函数：`weightedMean`/`weightedStd`/`precipitationProbability`/`precipLevel`/`conditionVote`/`beaufort`/`predictionInterval`/`confidence`/`riskFlags`
- 常量 `FORMULA_VERSION`（随行落库）、`RAIN_THRESHOLD_MM`、`RISK_THRESHOLDS`

### `engine/weights.ts` — 源权重动态校准
- `computeWeights(supabase)` — 每日重算入口：并行取一致性分 + 真值 MAE → 三层合成
- 纯函数：`scoreConsistency`（源偏离另两源中位数的平均绝对偏差）、`computeMae`（对 weather_truth 对账算平均绝对误差）、`blendWeights`/`blendParams`（α/β/γ 按真值天数过渡）、`median`
- 常量 `PRIOR`（先验权重）、`SOURCES`；类型 `Weights`（Record + `detail` 明细）

### `engine/divergence.ts` — 源间分歧检测（纯函数）
- `detectSourceDivergences(inputs)` — 降水分歧（湿/干两组）→ 条件分歧（>1 组）→ 温差分歧（spread ≥ 3°C）；供 prompt 注入强制核对指令

### `engine/truth.ts` — 参考真值采集
- `backfillTruth(supabase)` — 逐城逐源拉近 2 天历史取「昨天」观测，三源中位数 upsert `weather_truth`；随后轮换清理超 31 天旧行
- 内部 `pruneOldTruth` — 真值表有界（按东京日截止线删除）

### `db/db.ts` — ForecastAgent 持久化原语
- `readForecast(supabase, cityId, day, locale)` — 按 城×日×语言 读既有行
- `readForecastForCity(supabase, cityId, locale)` — 只读入口，本地日按城市时区实时计算（供轮询共用）
- `claimPending(service, cityId, day, locale, email)` — insert 认领 pending；23505 冲突读回现有行，failed 转回 pending 重试
- `settleRow(service, rowId, patch)` — 写终态（success 全指标 / failed 兜底）
- `clearPredictions(service)` — 整表清空预测（每日 cron 调用）
- `buildSourceInputs(supabase, cityId, day)` — 组装当日各源输入（daily 为主 + current 补湿度/风）
- `isWithinRetryCooldown(failedAt, now)` — 失败 5 分钟冷却判定；常量 `RETRY_COOLDOWN_MS`

### `common/errors.ts` — ForecastAgent 错误码
- 类型 `ForecastAgentErrorCode`：`no-model`/`retry-cooldown`/`insufficient-data`/`provider`/`parse`/`consistency`/`react-loop`/`generic`。编排与前端 hook/视图共享，避免 UI 反向依赖编排模块

---

## 3. `lib/schemas/` — Zod 信任边界 schema（前后端共用）

规则见 `.claude/rules/zod-usage.md`：只校验不可信输入，`z.infer` 推导类型，一处定义共用。

### `weather.ts` — 天气 canonical schema
- `sourceSchema` / `conditionCategorySchema` — 数据源枚举 / 归一粗分类枚举
- `cityPointSchema` / `weatherPointSchema` / `forecastItemSchema` / `normalizedWeatherSchema` — 城市入参、单点天气、预报项、单源归一化结果；类型 `CityPoint`/`WeatherPoint`/`ForecastItem`/`NormalizedWeather`
- 约定：时间统一 UTC ISO；conditionCode/Label 保留源值，跨源只比 conditionCategory

### `forecast-agent.ts` — ForecastAgent 信任边界 schema
- 常量 `METRICS`（指标 id，AI 引用/工具校验单一来源）与 `isMetricId`
- 类型 `SourceInput`/`PredictionResult`/`RiskFlag`（内核输出，内部可信）
- `reactTraceSchema` 等 — ReAct 轨迹（卡片读 jsonb 时 safeParse 兜底）
- `chatResponseSchema`/`chatUsageSchema` — 外部 AI 响应（不可信，运行时校验）
- `ForecastDbRow` — 预测行 snake_case 类型（对应 0006~0012 迁移）
- `REASONING_HEADINGS`/`FORECAST_HEADINGS`/`splitMarkdownDoc` — Markdown 两段切分
- `validateMarkdownDoc(md, result, opts?)` — 轻量校验：两段齐 + 高/低温与 poP 与集成结果容差内一致 + 温度/百分比防胡编钳制

### `ai.ts` — AI 模型配置 schema
- `connectionSchema` — URL 合法 + API Key 非空（测试链接用）
- `modelConfigSchema` — 连接 + 必选模型（确定保存用）
- `modelsResponseSchema` — OpenAI 兼容 `/models` 响应

### `auth.ts` — 认证 schema
- `loginSchema` / `registerSchema`（两段式：step1 密码+确认密码、step2 验证码）/ `verifySchema` / `forgotSchema` / `verifyResetSchema`
- 错误 message 均为 `auth.errors.*` i18n key；`zod v4 .check()` 做确认密码一致性

### `city.ts` — 城市表单 schema
- `createCitySchema` — 名称必填、经纬度字符串校验（避免空串静默成 0°）+ 范围、时区必填
- `deleteCitySchema` — 仅接受合法 uuid

---

## 4. `lib/` 其他

### `model-config.ts` — AI 模型配置存储（客户端，按邮箱隔离）
- `getModelConfig(email)`/`saveModelConfig(email, config)`/`clearModelConfig(email)` — localStorage 读写，带 SSR 守卫与 JSON/schema 兜底；快照缓存供 `useSyncExternalStore`
- `configKey(email)` — 存储键（邮箱小写归一）
- `subscribeModelConfig(listener)` — 订阅集合，变更时通知
- `buildModelsUrl(baseUrl)` — 拼 `/models` 地址（去尾斜杠、防重复）
- `loadModels(baseUrl, apiKey)` — 调 OpenAI 兼容 `/models`（走 fetchJson），返回模型 id 列表
- 错误类 `ModelConfigError`

### `utils.ts` — 通用工具
- `cn(...inputs)` — clsx + tailwind-merge 合并 className
- `formatWeatherNumber(value)` — 天气数值统一展示口径：默认一位小数，微量（一位小数显示成 0.0 的非零值）降级两位小数

---

## 5. `supabase/` — Supabase 客户端与认证

### `server.ts` — 服务端会话客户端
- `createClient()` — `createServerClient`（@supabase/ssr），认证 Cookie 与请求双向同步；供 Server Action / Route Handler 用；SSR 渲染期写 Cookie 异常吞掉交给 proxy 统一刷新

### `service.ts` — service_role 受信写客户端
- `createServiceClient()` — 绕过 RLS，仅用于管道写入与城市增删；**切勿在客户端 import**（防泄漏 service_role key）

### `proxy.ts` — 会话刷新中间件
- `updateSession(request, supabaseResponse)` — 在 intl 已产出的响应上同步/续期认证 Cookie（必须复用传入 response，重建丢 rewrite）；返回 `{response, user}` 供根 proxy 路由守卫

### `auth/actions.ts` — 认证 Server Actions（"use server"）
- `loginAction(values)` — 登录建立会话
- `registerSendCodeAction(values, opts?)` — 注册 step1：`is_email_registered` 预检（可选）→ signUp 发验证码
- `registerVerifyCodeAction(values)` — 注册 step2：verifyOtp(type:"signup")
- `forgotSendCodeAction(values)` — 忘记密码 step1：先用新密码试登录判断「新旧密码相同」→ resetPasswordForEmail 发码
- `forgotVerifyCodeAction(values)` — step2：verifyOtp(type:"recovery") → updateUser 落新密码 → 重新登录兜底
- `logoutAction()` — 退出登录
- 均返回 `AuthResult` 结果对象不抛错；错误经 `mapAuthError` 映射为受限码

### `auth/errors.ts` — 认证错误映射
- `mapAuthError(err)` — Supabase 错误 → 受限 `AuthErrorCode`（network/限流/OTP/用户存在等）
- 类 `AuthError` — 客户端 mutation 抛错携带 code 取 i18n 文案

---

## 6. `app/[locale]/` — 页面

### `layout.tsx` — 根布局
`generateStaticParams`（zh/en 两套静态路由）、`generateMetadata`；注入 `NextIntlClientProvider`（消息）+ `QueryProvider` + `TooltipProvider` + `ToastProvider`。

### `page.tsx` — 落地页
`Navbar` + `Body` + `Footer` 纵向堆叠（未登录入口）。

### `login/page.tsx` / `register/page.tsx` / `forgot-password/page.tsx`
`AuthCard` 外壳包裹对应表单组件。

### `dashboard/layout.tsx` — 仪表盘布局
服务端读会话取邮箱，未登录兜底重定向；`Sidenav`（管理员标志控制日志入口显隐）+ `DashboardNavbar` + 内容区。

### `dashboard/loading.tsx` — 子路由骨架加载
### `dashboard/page.tsx` — 占位首页（登录后跳转目标）
### `dashboard/ai-agent/page.tsx` — 占位 AI 页
### `dashboard/cities/page.tsx` — 服务端取城市 + 管理员标志 → `CitiesView`
### `dashboard/history/page.tsx` — 解析 `?city=` → 取近 7 天 `weather_daily` → `HistoryView`
### `dashboard/logs/page.tsx` — 管理员守卫；取最近 100 条 `weather_runs` → `LogsView`
### `dashboard/settings/page.tsx` — 渲染 `ModelConfigCard`（传入用户邮箱）
### `dashboard/forecast/page.tsx` — 预报页
解析 `?city=` 为唯一城市 → 取该城三源 `weather_current` + 最近一次 `weather_runs` → `ForecastView`。

---

## 7. `app/api/` — Route Handler（/api 不走 proxy，自带鉴权）

### `api/ai-agent/forecast/route.ts` — 预报流式端点
- `POST(request)` — 自鉴权（`createClient` + `getUser`，未登录 401）；body 中 model 配置属不可信输入，服务端再过 `modelConfigSchema`；流开始前错误用非 2xx JSON 返回，流开始后一切错误走带内 `error` 事件（SSE）
- 手动 `ReadableStream` start 模式逐事件编码 `data: {...}\n\n`；转发 `request.signal` 断线信号；Next 16 注意不设 `runtime="edge"`（node:dns 需 Node runtime）

---

## 8. `components/` — UI 组件

### `components/auth/`
- `login-form.tsx` — 登录表单：TanStack Form 校验 → `loginAction` mutation → 成功 toast + 跳转
- `register-form.tsx` — 两段式注册表单（step1 发码带 checkExists 预检、step2 验码），驱动 `registerSendCodeAction`/`registerVerifyCodeAction`
- `forgot-form.tsx` — 两段式忘记密码表单（新密码客户端暂存、验码后落库）

### `components/auth/presets/`
- `auth-card.tsx` — 认证页外壳（返回落地页按钮 + 语言切换 + 网格背景 + 磨砂玻璃卡）
- `auth-field.tsx` — 标签 + 输入框 + 内联错误容器
- `email-field.tsx` — 邮箱输入预设（固定 placeholder/autofill 语义，验码步锁定邮箱）
- `field-error.tsx` — 渲染 schema issue 信息（message 即 i18n key）

### `components/dashboard/forecast/`
- `forecast-view.tsx` — 预报页视图：城市下拉切换（导航到新 `?city=`）、管理员手动刷新、最近运行状态、左列城市三源卡 + 右列推理卡（等高限高）、「预报当日」按钮（配模型才可点）→ `useForecastStream` 流式渲染
- `forecast-agent-card.tsx` — ForecastAgent 结果卡：流式 Markdown 渲染、指标网格 + Markdown（新行）/旧结构化行兜底、受限错误码展示
- `forecast-metrics-grid.tsx` — 9 个指标图标卡（高/低/poP/降水等级/条件/风/湿度/置信度/风险），值取权威 DB 字段
- `forecast-reasoning-card.tsx` — ReAct 轨迹卡（thought/action/observation），流式渲染或读 `react_trace`，自动滚动到最新步

### `components/dashboard/cities/`
- `cities-view.tsx` — 城市只读表格 + 管理员新增入口 + 内联删除（确认弹窗，硬删级联）
- `city-add-dialog.tsx` — 新增城市弹窗（驱动 `createCityAction`，字段级 i18n 错误）

### `components/dashboard/history/`
- `history-view.tsx` — 历史视图：城市选择器 + 管理员刷新/回填 + 图表 + 每日表格
- `history-charts.tsx` — 4 个 KPI 瓦片 + 温度趋势折线（三源 high/low + 跨源区间带）+ 每日降水柱状 + 天气分布卡

### `components/dashboard/`
- `logs/logs-view.tsx` — `weather_runs` 只读表格（状态 pill、触发方式、格数、JST 时间）
- `navbar.tsx` — 顶部栏：面包屑 + 语言切换 + 邮箱 + 退出
- `sidenav.tsx` — 固定侧栏：品牌 + 图标导航（日志项仅管理员，无 href 项渲染禁用态）
- `logout-button.tsx` — 退出：`logoutAction` + 清用户级模型配置 + toast + 跳转
- `page-placeholder.tsx` — 开发中页面占位
- `settings/model-config-card.tsx` — 模型配置卡：`loadModels` 测试连接 → 选模型 → 按邮箱存 localStorage；清除按钮

### `components/notlogin/`
- `body.tsx` — 落地页 hero + 两个特性卡 + 登录/GitHub 按钮
- `navbar.tsx` — 落地页顶栏（品牌 + 语言切换 + 登录/注册）
- `footer.tsx` — 单行品牌页脚

### `components/providers/`
- `query-provider.tsx` — 根 TanStack Query Provider，关闭 mutation 重试（防重复提交）

### `components/ui-preset/` — 项目品牌化预设
- `button.tsx` — `ButtonBlue`/`ButtonGreen` 品牌按钮
- `data-table.tsx` — 通用只读表格（蓝色强调栏、空态、可选吸顶滚动），导出 `DataTable`/`DataTableRow`
- `forecast-card-shell.tsx` — 预报/推理卡共用外壳（tone 渐变 + 顶栏 + 状态点 + 阶段 + 滚动透传）
- `grid-background.tsx` — 浅色网格背景
- `language-toggle.tsx` — zh/en 切换胶囊
- `liquid-glass-card.tsx` — 磨砂玻璃卡
- `markdown.tsx` — react-markdown + GFM 渲染，元素映射 shadcn 风格类
- `toast.tsx` — `ToastProvider` + `useToast()`（success/error/info）
- `weather-city-card.tsx` — 城市三源当前天气卡；另导出 `WEATHER_SOURCES`/`SOURCE_COLORS` 共享常量

### `components/ui/` — shadcn 原语
`breadcrumb`/`button`/`card`/`chart`/`dialog`/`input`/`label`/`select`/`skeleton`/`table`/`tooltip` —— 基于 `@base-ui/react` 的薄展示层封装（常规调整用 variant/className，不改源码）。

---

## 9. `hooks/` — React hooks

### `use-forecast-stream.ts`
- `useForecastStream({cityId, locale, model, onDone, onError})` — 前端消费 SSE 流：POST `/api/ai-agent/forecast`，`getReader` 逐块读，复用 `lib/weather/sse` 解析；`delta` 逐字追加 markdown、`thought` 开新推理步、`tool` 归入当前步、`rollback` 回滚思考文字；返回 `{state, start, cancel, reset}`
- `state.status`：idle/streaming/done/error；这是 rules/fetch-usage「客户端不裸 fetch」的受控例外（真流式 TanStack Query 无法承载）

### `use-model-config.ts`
- `useModelConfig(email)` — `useSyncExternalStore` 订阅本地模型配置；SSR 恒 null，挂载后读 localStorage，保存/清除自动刷新

### `use-element-height.ts`
- `useElementHeight()` — ResizeObserver 观测元素实时高度，返回 `{ref, height}`；`useLayoutEffect` 首帧前完成测量

---

## 10. `i18n/` — 国际化

### `routing.ts`
- `routing` — `defineRouting({locales:["zh","en"], defaultLocale:"zh", localePrefix:"as-needed"})`（zh 无前缀，en 走 /en）

### `navigation.ts`
- 导出类型化 `Link`/`redirect`/`usePathname`/`useRouter`/`getPathname`（自动处理 locale 前缀，不手拼 URL）

### `request.ts`
- `getRequestConfig` — 从路由参数取 locale，未匹配支持语言走 404；加载 `messages/{locale}.json`

### `messages/zh.json` / `messages/en.json` — 文案资源（页面/表单/错误 i18n key）

---

## 11. `scripts/` 与根目录

### `scripts/weather-cron.ts` — GitHub Actions 每日采集入口
`runWeatherPipeline("cron")` → 清空预测表（`clearPredictions`）→ 回填真值（`backfillTruth`）；完整摘要打日志；全失败（succeeded=0）退出非零让工作流标红。恒不抛错。

### `proxy.ts` — 根中间件（next-intl + Supabase）
先 `intlMiddleware` 协商 locale，再 `updateSession` 刷新会话；`PUBLIC_PATHS` 白名单做路由守卫（未登录重定向 `/`，已登录重定向 `/dashboard`）。辅助函数：`localeOf`/`stripLocale`/`guardTarget`（均导出供单测）。

### `next.config.ts` — next-intl 插件 + `experimental.rootParams`
### `vitest.config.ts` — jsdom、setup、`@` 别名、v8 覆盖率只统计 `lib/` 与 `supabase/`
### `vitest.setup.ts` — 引入 jest-dom matcher
### `stryker.config.json` — 变异测试白名单（只变异「有测试」的 lib/supabase 源文件），80% break
### `.github/workflows/ci.yml` — push/PR 到 main：typecheck → lint → build；另 job 跑覆盖率上传 Codecov（OIDC）
### `.github/workflows/stryker.yml` — PR 定向变异（变更文件中有测试的源）
### `.github/workflows/weather-cron.yml` — 每日 15:00 UTC 直跑 `scripts/weather-cron.ts`

---

## 12. `supabase/migrations/` — 数据库迁移

| 迁移 | 内容 |
| --- | --- |
| `0001_weather.sql` | `cities`（name_en 唯一，种子 8 个日本城市）、`weather_current`（upsert 键 城×源）、`weather_runs`（运行状态/计数）|
| `0002_weather_daily.sql` | `weather_daily`（城×源×日快照，upsert 键 城×源×日）|
| `0003_rls.sql` | 四表启用 RLS，authenticated 只读 select 策略 |
| `0004_remove_weather_forecast.sql` | 删遗留 hourly `weather_forecast` 表 |
| `0005_email_registered.sql` | security-definer 函数 `is_email_registered`（注册预检，仅 service_role 可执行）|
| `0006_forecast_agent.sql` | `forecast_agent_predictions`（唯一 城×日、确定性指标列、AI 文本列、error_code）+ `weather_truth`（观测中位数真值）|
| `0007_forecast_agent_locale.sql` | 加 `locale` 列，唯一键改 城×日×语言 |
| `0008_forecast_agent_tokens.sql` | 加 `prompt_tokens`/`completion_tokens` |
| `0009_forecast_agent_react_trace.sql` | 加 `react_trace` jsonb（ReAct 轨迹）|
| `0010_forecast_agent_markdown.sql` | 加 `markdown_body`（AI 纯 Markdown 输出全文）|
| `0011_city_timezone_check.sql` | `cities.timezone` 加 CHECK 约束 `'Asia/Tokyo'` |
| `0012_forecast_agent_failed_at.sql` | 加 `failed_at`（失败冷却计时，替代原每日配额）|

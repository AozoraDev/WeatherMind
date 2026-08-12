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
lib/agent-core/         通用 AI/ReAct 基建（chat 调用 + ReAct 循环 + 多 agent 编排 + SSRF，两个 Agent 共用）
lib/forecast-agent/     确定性集成引擎 + AI 解读（ReAct 流式）
lib/ai-agent/           AI 助手对话（主 Agent 提示词/工具 + 会话库操作 + 聊天 SSE）
lib/schemas/            Zod 信任边界 schema（前后端共用）
lib/model-config.ts     AI 模型配置（localStorage 按邮箱隔离）
supabase/               Supabase 客户端（会话/受信写/代理刷新）与认证动作
supabase/migrations/    数据库迁移（0001~0014）
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
- 信号合并：外部 `init.signal`（客户端断线）与 `timeoutMs` 用 `AbortSignal.any` 合并，任一触发即取消；仅其一/都缺省时直接透传/省略（`fetchJson` 同规则）

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

### `pagination.ts` — Supabase 分页取数（服务端）
- `fetchPage<T>(query, page, pageSize)` — 对已配置 `select("*", { count: "exact" })` 与 `order` 的查询追加 `range`，返回该页 `rows` 与 `total`/`totalPages`（类型 `PageMeta`/`PageResult<T>`）；count 缺失用行数兜底
- 只依赖 `range` 的结构化类型：项目无生成 DB 类型（untyped client），避免写死 Postgrest 泛型
- 城市/日志页用它做服务端 URL 分页（页长固定每页 20 条）；历史页数据量小不走这里

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

## 2. `lib/agent-core/` — 通用 AI/ReAct 基建（两个 Agent 共用）

OpenAI 兼容 chat 调用 + ReAct 循环 + SSRF 防护，不依赖任何 Agent 领域逻辑；forecast-agent / ai-agent 共用。

### `chat.ts` — OpenAI 兼容 chat 共享原语
- `assertPublicBaseUrl(baseUrl)` — SSRF 前置（字面量白名单 + DNS 复核），返回错误码或 null
- `buildChatRequestBody(params, stream)` — wire 请求体（`temperature:0`、可选 tools、stream 标志）
- `toWireMessage`/`toWireTool` — 内部消息/工具 → OpenAI wire 形态
- `parseChatMessage(msg)` — wire 响应扁平化为 `{content, toolCalls}`
- 类型：`ChatMessage`（system/user/assistant/tool）、`ChatTool`、`ProviderErrorCode`

### `chat-stream.ts` — 流式 chat 调用
- `chatCompletionStream(params, opts?)` — 与 chat 同一 SSRF 前置；按 Content-Type 分发：SSE 流 / `application/json` 单帧降级 / 其余 parse。产出 `ChatStreamEvent`（`delta`/`tool`/`done`）；`opts.signal` 透传给 fetch（断线取消在途调用）
- 内部 `readSseChatStream` — 逐块读上游流、tool_calls 按 index 累计（**id/name 首现赋值、arguments 跨帧追加**——部分兼容端点每帧重复完整 id/name，按追加会拼出重复）、usage 从任意帧取；坏帧静默跳过；reader 提前 cancel 关流

### `react.ts` — ReAct 共享内核
- `safeParseJson(s)` — JSON.parse 严格封装
- `mergeUsage(a, b)` — 跨步 usage 累计
- `executeToolCalls(tools, toolCalls)` — 异步执行工具调用并构造 tool 消息（`ReactTool.execute` 可返回 Promise，主 Agent 的 generate_forecast 委托子 Agent 是耗时操作）；坏调用不中止（错误观察喂回模型自纠错）；参数为空串/字面 null 按空对象 `{}` 调用（无参 delegate 工具兜底）
- 类型：`ReactTool`/`ReactAction`/`ReactTrace`/`ReactLoopResult`

### `react-stream.ts` — 流式 ReAct 循环
- `runReActLoopStream(params)` — 循环至多 `maxSteps`（默认 4）：每步调 chat 流、delta 即时透传、工具步发 `thought`+`rollback`（思考文字回滚出正文）+`tool`（间隔展示），步序 `onTrace` 回调写实时轨迹；最终步无工具调用 → `result`（含 content/usage/trace）。步数耗尽/空响应归 `react-loop`，断流归 `network`。参数 `signal?` 透传给每次上游调用、每轮开头已中止直接归 `network`（断线省 token）；工具步历史 assistant 消息 `content` 回传思考文字（模型续思路用，空串仍落 null 兼容部分 provider）

### `orchestrator.ts` — 通用主管+专家编排层（领域无关）
- `runSupervisedStream({model, ctx, supervisor, specialists, onTrace?, signal?})` — AsyncGenerator 产出 `OrchestratorStreamEvent`：主管一个 ReAct 循环，每位专家被包装成 `delegate_<agentId>` 工具注入主管工具列表，主管调 delegate 即触发专家完整执行，观察=专家最终内容；`signal` 透传给主管与专家各自的循环（断线取消在途委托）
- 类型：`SpecialistAgent`（agentId/工具/提示词构建 + maxSteps/timeoutMs）、`SupervisorConfig`（buildTools 收到 delegate 工具可再追加）、`OrchestratorStreamEvent`（`agent_start`/`agent_end`/`delta`/`thought`/`rollback`/`tool`/`result`，前五者带 agentId）、`OrchestratorResult`（ok 时 content/usage/trace，trace 每步带 `agent_id`）
- 实现要点：channel 泵解耦主管任务与生成器消费（防事件丢失/死锁）；只有主管的 delta/rollback 对外发出，专家 delta/rollback 丢弃（以 delegate 观察呈现）；usage 跨 agent `mergeUsage` 聚合；轨迹按事件发生全局时间序扁平化；断线后 `channel.end()` 收敛无悬挂

### `ssrf.ts` — SSRF 防护（纯函数）
- `isAllowedBaseUrl(url)` — 仅 https + host 不在私网/保留名单
- `isPrivateHost(host)` — IPv4/IPv6 字面量私网判定（含内嵌 IPv4 映射、6to4、ULA、link-local 等）、`.local`/`.internal` 保留 TLD
- `hostResolvesToPublic(host)` — 解析出的全部 A/AAAA 必须公网，防「公共域名解析到内网」

### `dns.ts` — DNS 解析隔离
- `resolveHostAll(host)` — 包一层 `node:dns/promises.lookup({all:true})`；测试可 `vi.mock("./dns")`

---

## 3. `lib/forecast-agent/` — 确定性集成 + AI 解读

「先算后讲」：`engine/` 是纯函数数学内核（可复现、可单测），`agent/` 是提示词与工具注册表，ReAct 循环与 chat 原语由 `lib/agent-core/` 提供，`stream/` 是流式编排，`db/` 是持久化原语。天气数值一律由内核产出，AI 只把指标翻译成自然语言，从根上无法编造数字。

### `stream/stream.ts` — 流式编排（唯一生成入口）
- `runForecastAgentStream(session, service, params)` — AsyncGenerator 产出 `ForecastAgentStreamEvent`：
  读既有→success/pending 直接 `duplicate`；failed 走 5 分钟冷却判定后重试；`claimPending` 认领唯一键 城×日×语言 → `predict` 集成 → `runSupervisedStream` 多 agent 编排 → `validateMarkdownDoc` 轻量校验 → `settleRow` 落库。
  事件类型：`status`（阶段）/`delta`/`thought`/`rollback`/`tool`（均带 `agentId`，delta 仅主管到达前端）/`agent_start`/`agent_end`（边界）/`duplicate`/`done`/`error`。
  生成期失败统一落库 failed + `failed_at`；断线由 finally 兜底清理 pending 行。

### `agent/tools.ts` — ReAct 工具注册表
- `buildTools({result, locale})` — 单个只读工具：
  - `query_source(source)` — 回读某源原始预报快照（核对分歧用；get_metric 已移除——指标表内联在提示词里，原样再查一遍纯属重复）
  - 参数校验 JSON-schema 与 execute 内 zod 校验器同形；工具描述跟随 locale

### `agent/specialists.ts` — 预报生成的专家团注册
- 类型 `ForecastAgentCtx`（city/日期/确定性 result/语言）——各 agent 提示词与工具组装共用
- 常量 agent id：`SUPERVISOR_AGENT_ID`/`RECONCILE_AGENT_ID`/`RISK_AGENT_ID`
- `buildReconcileSpecialist(ctx)` — 源核对专家：复用 `buildTools`（query_source），maxSteps=3
- `buildRiskSpecialist(ctx)` — 风险解读专家：无工具，maxSteps=1
- `buildSupervisorConfig(ctx)` — 统筹主管：buildTools 原样透传 delegate 工具，maxSteps=4
- `toolDescription` 随 locale（en 模式 delegate 工具文档必须英文）

### `agent/prompt.ts` — AI 提示词组装（按 agent 拆分）
- 类型 `ForecastAgentCtx` — 各 agent 共享上下文（见 specialists.ts）
- `buildSupervisorMessages(ctx)` — 主管：任务层硬性要求先调 `delegate_reconcile`/`delegate_risk` 再定稿（确定性委托）；输出契约仅 `## 推理过程` + `## 预报` 两段
- `buildReconcileMessages(ctx)` — 源核对专家：只读约束 + 分歧块强制 `query_source` 逐源核对；输出供主管引用的结论
- `buildRiskMessages(ctx)` — 风险解读专家：只解读 risk_flags、不得虚构；无工具
- `formatMetricValue(locale, result, metricId)` — 指标值唯一格式化来源（提示词指标表组装用）
- `buildContext`/`divergenceBlock` — 导出供各 agent 的 user 数据段复用
- 常量 `METRIC_ROW_IDS` — 指标表顺序单一来源

### `agent/prompt-text.ts` — 提示词本地化文案表
- 常量 `TEXTS` — zh/en 两套文案（指标表模板、条件/等级/可信度标签、风险行、分歧块模板），占位符 `{key}` 由 prompt.ts 的 fill 替换
- 类型 `LocaleText` / `MetricMeta` / `AgentRoleText`；`LocaleText.agentRoles` — supervisor/reconcile/risk 三份 system 五层文本；`supervisorUserOutput` — 主管 user 尾部两段输出契约

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
- `FORECAST_ERROR_CODES`（集合）+ `isForecastErrorCode(code)` — 已知码判定（UI 取 i18n 文案前过滤非法码，防御外部 error_code 漂移）

---

## 4. `lib/schemas/` — Zod 信任边界 schema（前后端共用）

规则见 `.claude/rules/zod-usage.md`：只校验不可信输入，`z.infer` 推导类型，一处定义共用。

### `weather.ts` — 天气 canonical schema
- `sourceSchema` / `conditionCategorySchema` — 数据源枚举 / 归一粗分类枚举
- `cityPointSchema` / `weatherPointSchema` / `forecastItemSchema` / `normalizedWeatherSchema` — 城市入参、单点天气、预报项、单源归一化结果；类型 `CityPoint`/`WeatherPoint`/`ForecastItem`/`NormalizedWeather`
- 约定：时间统一 UTC ISO；conditionCode/Label 保留源值，跨源只比 conditionCategory

### `forecast-agent.ts` — ForecastAgent 信任边界 schema
- 常量 `METRICS`（指标 id，AI 引用/工具校验单一来源）与 `isMetricId`
- 类型 `SourceInput`/`PredictionResult`/`RiskFlag`（内核输出，内部可信）
- `reactTraceSchema` 等 — ReAct 轨迹（卡片读 jsonb 时 safeParse 兜底）；步骤含可选 `agent_id`（多 agent 编排后标记所属 agent，旧行 null 前端回落单组时间线）
- `ForecastDbRow` — 预测行 snake_case 类型（对应 0006~0012 迁移）
- `REASONING_HEADINGS`/`FORECAST_HEADINGS`/`splitMarkdownDoc` — Markdown 两段切分
- `validateMarkdownDoc(md, result, opts?)` — 轻量校验：两段齐 + 高/低温与 poP 与集成结果容差内一致 + 温度/百分比防胡编钳制
- 通用 AI wire schema（`chatResponseSchema`/`chatUsageSchema`）已挪至 `agent-core.ts`

### `agent-core.ts` — 通用 AI wire schema（OpenAI 兼容 chat 响应）
- `chatUsageSchema`/`ChatUsage` — usage 计费字段（prompt/completion/total），部分代理缺省故整块可选
- `chatResponseSchema` — choices[].message（content + 可选 tool_calls）+ 可选 usage；外部 AI 响应，运行时校验

### `ai.ts` — AI 模型配置 schema
- `connectionSchema` — URL 合法 + API Key 非空（测试链接用）
- `modelConfigSchema` — 连接 + 必选模型（确定保存用）
- `modelsResponseSchema` — OpenAI 兼容 `/models` 响应

### `ai-agent.ts` — AI 助手对话 schema
- `conversationMessageSchema` / `conversationMessagesSchema` — 消息对象 / 数组（role user|assistant + content + created_at + 可选 usage 复用 `chatUsageSchema` + 可选 `a2ui` 复用 `a2uiMessageSchema`，服务端生成的卡片消息串 jsonb 持久化）；类型 `ConversationMessage`
- `chatRequestBodySchema` — 聊天请求体：conversationId uuid + content 非空 + locale zh/en + model 复用 `modelConfigSchema`
- `deleteConversationSchema` — 仅接受合法 uuid；类型 `ConversationRow`（id/title/updated_at）
- DB 读回的 messages jsonb 在边界 safeParse 兜底

### `a2ui.ts` — a2ui 卡片消息 schema（聊天卡片持久化共用）
- 常量 `BASIC_CATALOG_ID` — @a2ui/react basicCatalog 的 catalogId 字符串（服务端引用不 import React）
- `a2uiComponentSchema` / `a2uiMessageSchema` — v0.9 消息信封（createSurface/updateComponents/updateDataModel/deleteSurface）与组件结构校验；类型 `A2uiComponent`/`A2uiMessage`
- `a2uiMessagesSchema` — 消息数组（DB 读回 jsonb 在边界 safeParse 兜底，配合 `conversationMessageSchema.a2ui`）
- catalog 组件 schema（MetricTile）在 `a2ui-catalog.ts`：web_core 运行时固定 zod ^3.25.76，组件 schema 必须与其同源（v3 zod，经 npm 别名 zod-v3 引入），故与消息信封（v4 zod）分文件

### `a2ui-catalog.ts` — a2ui catalog 组件 schema（客户端渲染器严格校验）
- `metricTileSchema` — MetricTile 预报指标磁贴组件 schema（zod v3 与 web_core 运行时同源；icon/chip 语义键 + label 静态文案 + value/sub 复用 web_core 导出的 `DynamicStringSchema`，`{path}` 绑定 / `{call}` 函数调用 / 字面量；`.strict()` 拒绝未知字段）；服务端模板（forecast-card.ts）发出的磁贴消息必须与其对齐；类型 `MetricTileProps`
- 用 v3 的原因：GenericBinder 靠 `_def.typeName` 识别动态字符串（v4 zod 移除）、校验失败靠 `error.errors` 取路径（v4 只有 issues）

### `auth.ts` — 认证 schema
- `loginSchema` / `registerSchema`（两段式：step1 密码+确认密码、step2 验证码）/ `verifySchema` / `forgotSchema` / `verifyResetSchema`
- 错误 message 均为 `auth.errors.*` i18n key；`zod v4 .check()` 做确认密码一致性

### `city.ts` — 城市表单 schema
- `createCitySchema` — 名称必填、经纬度字符串校验（避免空串静默成 0°）+ 范围、时区必填
- `deleteCitySchema` — 仅接受合法 uuid

### `pagination.ts` — 分页查询参数 schema（前后端共用）
- `paginationParamsSchema` — `?page=` 归一校验：字符串转数字、page≥1，缺省给默认值（页长固定每页 20 条，不随 URL 变化）
- `parsePagination(params)` — safeParse 成功返回归一结果，非法回退默认 `{ page: 1 }`
- 常量 `DEFAULT_PAGE_SIZE`（20）；`totalPages(total, pageSize)` — 至少 1 页
- 纯前后端共用（无服务端依赖），前端分页条与 `totalPages` 也用它

---

## 5. `lib/` 其他

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

### `ai-agent/` — AI 助手对话模块

主 Agent 模块，按 forecast-agent 同款拆分：`agent/` 是主 Agent 的提示词与工具注册表，`common/` 是跨路由共享的错误码/事件契约/SSE 工具，`db/` 是会话增删的 Server Actions（持久化原语）。

### `ai-agent/agent/prompt.ts` — 主 Agent 提示词（上下文 + 委托策略）
- `buildMainAgentSystemPrompt(locale, today)` — 系统提示词按语言输出：身份（WeatherMind 天气主 Agent）、今日参考日期（JST）、平台背景（3 源数据 + 近 7 天历史快照 + 多源确定性集成）、意图分流（一般对话 / 没问权威预报的今天天气默认走 query_sources 给 3 源 / 历史天气走 query_weather_history / 问今日预报走 query_forecast→无数据则 generate_forecast / 超出覆盖如实说明）、铁律（数值必须来自工具、语言跟随用户、**预报去重复：拿到权威预报时 a2ui 图标卡片自动展示关键指标，正文只写简洁叙述、不输出指标表格**）。工具定义由请求的 tools 字段提供，提示词只给策略流程、不复述工具描述（省 token）
- `buildMainAgentMessages(history, locale, today)` — 库内历史 → wire ChatMessage（前置 system；工具过程不落库，历史只含 user/assistant）

### `ai-agent/agent/tools.ts` — 主 Agent 工具注册表
- `buildMainAgentTools({session, service, email, model, locale, signal})` — 五个工具（参数 zod 校验与发往 API 的 JSON-schema 同形；`signal` 透传给委托的子 Agent——主 Agent 断线时子 Agent 不再继续烧 token）：
  - `query_city(keyword)` — cities 表按日/英文 ILIKE 模糊搜（`%`/`_`/`\`/`,` 转义——逗号是 PostgREST `.or()` 分隔符，不转义会把 "Tokyo, Japan" 切成多个条件报错），is_active 过滤、limit 5
  - `query_sources(cityId)` — 定位城市取时区算本地今日（`toLocalDateKey`）后读 `weather_daily` 当日各源快照（高温/低温/降水/天气状况），逐源映射带显示名 label；无数据 no-data / 查询报错 error（城市 DB 故障与「不存在」区分）
  - `query_weather_history(cityId, days?)` — 读 `weather_daily` 近 days 天（默认 7、上限 7 与平台保留窗口一致，schema 越界拒绝）各源每日快照，按城市本地日分组（天内逐源、带显示名 label）；无数据 no-data / 查询报错 error
  - `query_forecast(cityId)` — `readForecastForCity` 读今日预报：无数据 no-data / failed error+error_code / success 指标观察
  - `generate_forecast(cityId)` — **异步委托子 Agent**：消费 `runForecastAgentStream`，done/duplicate 取行 → 指标观察，error 透传子 Agent 错误码；无 email 拒绝（认领需 created_by）

### `ai-agent/common/errors.ts` — 会话动作受限错误码（客户端共享，照 weather/errors 模式）
- `ConversationActionErrorCode` — `unauthorized`/`invalidInput`/`notFound`/`generic`
- `ConversationActionError` — 客户端 mutationFn 抛出的错误类，`code` 供 i18n 取文案；Server Actions 返回结果对象不抛错，错误码映射在此集中

### `ai-agent/common/chat-events.ts` — 聊天 SSE 事件类型（纯类型）
- `ChatSseEvent` — `{type:"delta",text}` / `{type:"rollback",chars}`（工具步思考文字回滚，不属于最终回答正文）/ `{type:"a2ui",messages}`（服务端模板化的卡片消息串，done 前到达）/ `{type:"done",content,usage}`（usage 为本次请求跨步累计 token 消耗，缺省 null）/ `{type:"error",code}`（code 取 `ProviderErrorCode` 或 "generic"）；聊天路由与客户端 hook 共用

### `ai-agent/common/route-helpers.ts` — /api/ai-agent 流式路由共用工具
- `requireUser()` — 自鉴权（`createClient` + `getUser`，未登录返回 401 Response），连同 session 一并返回供 RLS 查询/传参
- `readJsonBody(request)` — 解析 JSON body，失败按 400 "no-model" 口径返回
- `createSseResponse(run)` — SSE 响应构造（手动 `ReadableStream` start 模式逐事件编码、外层 catch 兜底带内 generic、finally close），返回带 `SSE_RESPONSE_HEADERS` 的 Response
- 常量 `SSE_RESPONSE_HEADERS` — 4 个 SSE 响应头

### `ai-agent/db/conversation-actions.ts` — 会话增删 Server Actions（"use server"）
- `createConversationAction()` — `getUser` 取 user.id（无 → unauthorized）→ service 客户端新建会话返回 id
- `deleteConversationAction({id})` — schema 先验（失败 invalidInput）→ `getUser` → 按 id + user_id 删除；0 行 → notFound
- 均返回结果对象不抛错；错误码 `unauthorized`/`invalidInput`/`notFound`/`generic`；消息持久化由 chat 路由负责，actions 不碰 messages

### `ai-agent/a2ui/forecast-card.ts` — 天气结果卡模板化（纯函数，服务端）
- `buildForecastCardMessages(input, locale): A2uiMessage[]` — 把主 Agent 工具观察的权威指标（`ForecastCardMetrics`，与 tools.ts 观察同形）模板化成 a2ui v0.9 三条消息（createSurface → updateComponents → updateDataModel）：根 Column（无 Card，背景由宿主绿色渐变透出）→ 标题 Text + 每行两张 `MetricTile` 的 Row（icon/chip 语义键 + label 静态文案 + value/sub 绑 `{path:"/key"}` 与 `{path:"/keyInterval"}`）；容器 children 引用的 id 必须真实存在于组件表，否则渲染回退成 [Loading row-...] 占位；固定行序（最高/最低带区间说明→降水概率/等级→状况→风力→湿度→可信度→风险），末行单张；空值跳过磁贴、风险标记逐条「类型（级别）」拼接；数值取整显示，文案复用 forecast-agent 的 `TEXTS` 本地化表（口径与预报正文一致）；缺城市名标题用「今日预报」兜底。模型不生成 UI、不转述数值，卡片只回读工具观察

### `ai-agent/a2ui/capture.ts` — 工具观察收集器（纯函数，路由内增量调用）
- `createForecastCardAccumulator()` — 累积器初始态（cityNames/forecast/cityId）
- `reduceToolEvent(acc, ev, locale)` — 从 `tool` 事件提取：query_city 记 id→显示名（locale 取 name_ja/name_en，首选缺失回退另一语言）；query_forecast/generate_forecast 且 `status==="success"` 时记最新 metrics/cityId（后到覆盖）；no-data/error/pending 与其他工具忽略
- `toForecastCardInput(acc)` — 累积完转 `{cityName, metrics}`，无成功预报返回 null（调用方不发卡片）

---

## 6. `supabase/` — Supabase 客户端与认证

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

## 7. `app/[locale]/` — 页面

### `layout.tsx` — 根布局
`generateStaticParams`（zh/en 两套静态路由）、`generateMetadata`；注入 `NextIntlClientProvider`（消息）+ `QueryProvider` + `TooltipProvider` + `ToastProvider`。

### `page.tsx` — 落地页
`Navbar` + `Body` + `Footer` 纵向堆叠（未登录入口）。

### `login/page.tsx` / `register/page.tsx` / `forgot-password/page.tsx`
`AuthCard` 外壳包裹对应表单组件。

### `dashboard/layout.tsx` — 仪表盘布局
服务端读会话取邮箱，未登录兜底重定向；`Sidenav`（管理员标志控制日志入口显隐）+ `DashboardNavbar` + 内容区。

### `dashboard/loading.tsx` — 子路由骨架加载
### `dashboard/page.tsx` — 首页总览（登录后跳转目标）
读会话判定管理员态 → `DashboardHomeView`（欢迎横幅 + 功能入口卡片，日志卡仅管理员）。
### `dashboard/ai-agent/page.tsx` — AI 助手聊天页
服务端取会话列表（按 updated_at 倒序）+ 当前会话初始消息（messages jsonb safeParse 兜底）；`?id=` 解析照 resolve-city（缺失/无效重定向到规范 URL）；未配置模型拦截在客户端（见 AiAgentView）。
### `dashboard/ai-agent/setup/page.tsx` — 未配置模型提示页
由 AiAgentView 客户端重定向至此；文案 + `SetupGuide`「去配置模型」按钮跳设置页。
### `dashboard/cities/page.tsx` — 服务端按 `?page=` 分页取城市（页长固定每页 20 条）+ 管理员标志 → `CitiesView`；页码越界重定向回最后一页
### `dashboard/history/page.tsx` — 解析 `?city=` → 取近 7 天 `weather_daily` → `HistoryView`（服务端一次取全量，表格前端切片分页）
### `dashboard/logs/page.tsx` — 管理员守卫；按 `?page=` 分页取 `weather_runs`（页长固定每页 20 条）→ `LogsView`（卡片撑满剩余高度、表内滚动，分页条钉在底部）；页码越界重定向回最后一页
### `dashboard/settings/page.tsx` — 渲染 `ModelConfigCard`（传入用户邮箱）
### `dashboard/forecast/page.tsx` — 预报页
解析 `?city=` 为唯一城市 → 取该城三源 `weather_current` + 最近一次 `weather_runs` → `ForecastView`。

---

## 8. `app/api/` — Route Handler（/api 不走 proxy，自带鉴权）

### `api/ai-agent/forecast/route.ts` — 预报流式端点
- `POST(request)` — 鉴权走公共 `requireUser`（未登录 401）；body 中 model 配置属不可信输入，服务端再过 `modelConfigSchema`；流开始前错误用非 2xx JSON 返回，流开始后一切错误走带内 `error` 事件（SSE）
- 流构造走公共 `createSseResponse`（手动 `ReadableStream` start 模式逐事件编码 + 断流兜底）；转发 `request.signal` 断线信号；Next 16 注意不设 `runtime="edge"`（node:dns 需 Node runtime）

### `api/ai-agent/chat/route.ts` — 主 Agent 对话流式端点
- `POST(request)` — 鉴权走公共 `requireUser`（未登录 401）；body 过 `chatRequestBodySchema`（失败 400）；会话归属校验（RLS 兜底，无行 404 `conversation-not-found`）；**用户消息经原子追加 RPC `append_conversation_message` 落库**（单条 UPDATE 行级追加，防多标签页读改写丢消息；返回权威 messages 数组）再进主 Agent ReAct 循环（`runReActLoopStream`，maxSteps 6、单步 timeout 300s）：消息经 `buildMainAgentMessages`（含今日参考日期）、工具经 `buildMainAgentTools`（查城市/查预报/委托子 Agent 生成）；消费循环用 `reduceToolEvent` 累积工具观察（城市名 + 预报指标）；流构造走 `createSseResponse`，只转发 delta/rollback/done/error（**只显示最终回答**，工具步的 thought/tool 消费不转发，思考文字经 rollback 回滚；**累积到成功预报时 done 前发 `{type:"a2ui"}` 卡片消息**）；**assistant 回复在 `result` 分支先落库（同一 RPC，带 usage 与 a2ui）再发 done**——done 到达时客户端刷新必然读到全量回复，落库失败发 error 不宣称成功；done 透传 `result.usage`；**转发 `request.signal`**——客户端断开即中止在途 LLM 调用省 token，回复不落库（只保留用户消息）

---

## 9. `components/` — UI 组件

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
- `forecast-reasoning-card.tsx` — 多 agent 时间线卡：按 `agent_id` 分组渲染（组头 = `agentLabel` 本地化，未知 id 回落 raw；旧行无标记归单组不加组头），流式渲染或读 `react_trace`，自动滚动到最新步

### `components/dashboard/ai-agent/`
- `ai-agent-view.tsx` — 聊天页主视图（"use client"）：左会话栏 + 右聊天区；`useHydrated` 检测挂载后判 modelConfig（SSR 恒 null），null → `router.replace("/dashboard/ai-agent/setup")`（防首屏误跳）；聊天区按 conversationId 键控，切换会话即重挂载
- `conversation-list.tsx` — 会话栏：「新建对话」按钮 + 会话列表（active 高亮、hover 删除图标、Dialog 确认）；驱动 `createConversationAction`/`deleteConversationAction`，成功后 `router.refresh()` + 导航；空标题显示默认名
- `chat-panel.tsx` — 聊天面板：消息列表（自动滚动）+ 输入区（Enter 发送/Shift+Enter 换行，trim 空或流式中禁用）；`useChatStream` 流式渲染，done 追加 assistant（携带 usage 与 a2ui 卡片消息串）+ refresh；error 映射 i18n 文案 + 半成品灰显
- `message-bubble.tsx` — 消息气泡：user 右对齐 primary 气泡、assistant 左对齐卡 `<Markdown>`；流式态显示指示点；带 usage 的 assistant 消息在下方渲染 token 消耗页脚（仿预报卡片 footer）；带 a2ui（服务端生成的卡片消息串）时在 markdown 下方渲染 `<A2uiCard>`
- `a2ui-card.tsx` — 渲染服务端下发的 a2ui 卡片（"use client"）：每条消息独立 `MessageProcessor([aiAgentCatalog])`（basicCatalog + 自定义 MetricTile，见下），订阅 surface 创建/删除同步列表，`<A2uiSurface>` 原生渲染；`injectStyles` 幂等注入结构样式（SSR 跳过）；`processMessages` 以消息引用变化守卫防 StrictMode 双挂载重复处理，异常整体降级为空渲染不阻塞聊天。外层借 forecast-agent 结果卡（ForecastCardShell 成功态）视觉语言：绿色渐变容器 + 顶部色条 + 圆角边框阴影；DB 里旧 Card 根节点消息自带不透明背景/边框，用 CSS 变量（--a2ui-card-*）归零让渐变透出
- `a2ui-catalog.tsx` — ai-agent 自定义 a2ui catalog（"use client"）：在 basicCatalog 上追加 `MetricTile` 组件（createComponentImplementation + `metricTileSchema`）；MetricTile 把服务端下发的 icon/chip 语义键映射到 lucide 图标 + 彩色图标块，与预报页 ForecastMetricsGrid 口径一致（图标表 ICONS、配色表 CHIPS，未知键兜底）
- `setup-guide.tsx` — 提示页「去配置模型」按钮 → 跳设置页（配置保存后 localStorage 订阅自动刷新）

### `components/dashboard/cities/`
- `cities-view.tsx` — 城市只读表格 + 管理员新增入口 + 内联删除（确认弹窗，硬删级联）
- `city-add-dialog.tsx` — 新增城市弹窗（驱动 `createCityAction`，字段级 i18n 错误）

### `components/dashboard/history/`
- `history-view.tsx` — 历史视图：城市选择器 + 管理员刷新/回填 + 图表 + 每日表格（前端切片分页，每页 20 条）
- `history-charts.tsx` — 4 个 KPI 瓦片 + 温度趋势折线（三源 high/low + 跨源区间带）+ 每日降水柱状 + 天气分布卡

### `components/dashboard/`
- `logs/logs-view.tsx` — `weather_runs` 只读表格（状态 pill、触发方式、格数、JST 时间）
- `navbar.tsx` — 顶部栏：面包屑 + 语言切换 + 邮箱 + 退出
- `sidenav.tsx` — 固定侧栏：品牌 + 图标导航（日志项仅管理员，无 href 项渲染禁用态）
- `logout-button.tsx` — 退出：`logoutAction` + 清用户级模型配置 + toast + 跳转
- `home/dashboard-home-view.tsx` — 首页总览（服务端组件）：渐变欢迎横幅（今日日期，东京时区）+ 功能入口卡片网格；色带与各页主题对应，日志卡仅管理员
- `settings/model-config-card.tsx` — 模型配置卡：`loadModels` 测试连接 → 选模型 → 按邮箱存 localStorage；清除按钮

### `components/notlogin/`
- `body.tsx` — 落地页 hero + 两个特性卡 + 登录/GitHub 按钮
- `navbar.tsx` — 落地页顶栏（品牌 + 语言切换 + 登录/注册）
- `footer.tsx` — 单行品牌页脚

### `components/providers/`
- `query-provider.tsx` — 根 TanStack Query Provider，关闭 mutation 重试（防重复提交）

### `components/ui-preset/` — 项目品牌化预设
- `button.tsx` — `ButtonBlue`/`ButtonGreen` 品牌按钮
- `data-table.tsx` — 通用只读表格（蓝色强调栏、空态、可选吸顶滚动），导出 `DataTable`/`DataTableRow`；可选 `pagination` prop 在表底渲染分页条（单页不显示）；`scrollable` 时撑满父容器高度、表内滚动，分页条钉在底部
- `table-pagination.tsx` — 通用分页条（`TablePagination`）：共 N 条 · 每页 20 条（页长固定，不提供切换）、上一页/页码/下一页；不感知数据来源，城市/日志注入 URL 导航回调、历史页注入前端切片回调
- `forecast-card-shell.tsx` — 预报/推理卡共用外壳（tone 渐变 + 顶栏 + 状态点 + 阶段 + 滚动透传）
- `grid-background.tsx` — 浅色网格背景
- `language-toggle.tsx` — zh/en 切换胶囊
- `liquid-glass-card.tsx` — 磨砂玻璃卡
- `markdown.tsx` — react-markdown + GFM 渲染，元素映射 shadcn 风格类
- `toast.tsx` — `ToastProvider` + `useToast()`（success/error/info）
- `weather-city-card.tsx` — 城市三源当前天气卡；另导出 `WEATHER_SOURCES`/`SOURCE_COLORS` 共享常量

### `components/ui/` — shadcn 原语
`breadcrumb`/`button`/`card`/`chart`/`dialog`/`input`/`label`/`select`/`skeleton`/`table`/`textarea`/`tooltip` —— 基于 `@base-ui/react` 的薄展示层封装（常规调整用 variant/className，不改源码）。

---

## 10. `hooks/` — React hooks

### `use-sse-stream.ts`
- `useSseStream({url, model, buildBody, onTransportError, onNoBodyError, onParseError, decodeError, onEvent, onReset, onError})` — SSE 传输层通用 hook：POST 发起、`getReader` 逐块读、复用 `lib/weather/sse` 解析，逐事件回调 `onEvent`（ctx 提供 `markDone`/`fail`）；收敛状态机（idle/streaming/done/error）+ AbortController + 断网兜底 + 错误码映射；返回 `{status, errorCode, start(params), cancel, reset}`。在途期间重复 `start` 被忽略（防快速连点双请求），新一轮 `start` 先经 `onReset` 清上一轮累积内容（防重试/多轮残留拼接到新回复）。流正常关闭但未收到终态事件（服务端异常断开/代理掐断）归 `onTransportError`，不永久卡 streaming。`useForecastStream`/`useChatStream` 共用
- 这是 rules/fetch-usage「客户端不裸 fetch」的受控例外（真流式 TanStack Query 无法承载）

### `use-forecast-stream.ts`
- `useForecastStream({cityId, locale, model, onDone, onError})` — 预报流式 hook（useSseStream 薄封装，只做事件→内容分发）：`delta` 逐字追加 markdown、`agent_start` 开时间线分组、`thought`/`tool` 归入所属 agent 组、`rollback` 回滚思考文字、`duplicate`/`done` 定稿回读行并按 `react_trace` 重新分组；返回 `{state, start, cancel, reset}`
- `state.status`：idle/streaming/done/error
- `groupByAgent(trace)` — 按相邻 `agent_id` 分组保序（旧行归 `agentId:""` 单组）；`state.agents` — `TimelineGroup[]`，hook 与推理卡共用

### `use-chat-stream.ts`
- `useChatStream({model, locale, onA2ui, onDone, onError})` — 聊天流式 hook（useSseStream 薄封装）：`delta` 累积 assistantText、`rollback` 把工具步思考文字从尾部回滚、`a2ui` 暂存卡片消息串（`state.a2uiMessages` 供流式期气泡展示，`onDone(content, usage, a2ui)` 一并回传）、`done` 收尾（携带本次 token 消耗，供气泡下页脚展示）、`error` 带错误码；返回 `{state, start({conversationId, content}), cancel, reset}`；非 2xx `error` 字段映射受限码（`conversation-not-found` → `conversationNotFound`）；不持有消息列表（父组件持有）

### `use-model-config.ts`
- `useModelConfig(email)` — `useSyncExternalStore` 订阅本地模型配置；SSR 恒 null，挂载后读 localStorage，保存/清除自动刷新

### `use-element-height.ts`
- `useElementHeight()` — ResizeObserver 观测元素实时高度，返回 `{ref, height}`；`useLayoutEffect` 首帧前完成测量

### `use-paginated-navigation.ts`
- `usePaginatedNavigation(baseQuery={})` — 服务端分页导航：`goToPage(page)` 写查询串后 `router.push`（页长固定每页 20 条，不携带 pageSize）；`baseQuery` 保留既有参数（如历史页 `?city=`）；不读 `useSearchParams`，规避 client 组件 Suspense 构建约束

---

## 11. `i18n/` — 国际化

### `routing.ts`
- `routing` — `defineRouting({locales:["zh","en"], defaultLocale:"zh", localePrefix:"as-needed"})`（zh 无前缀，en 走 /en）

### `navigation.ts`
- 导出类型化 `Link`/`redirect`/`usePathname`/`useRouter`/`getPathname`（自动处理 locale 前缀，不手拼 URL）

### `request.ts`
- `getRequestConfig` — 从路由参数取 locale，未匹配支持语言走 404；加载 `messages/{locale}.json`

### `messages/zh.json` / `messages/en.json` — 文案资源（页面/表单/错误 i18n key）

---

## 12. `scripts/` 与根目录

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

## 13. `supabase/migrations/` — 数据库迁移

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
| `0013_ai_conversations.sql` | `ai_conversations`（user_id 无 FK、title、messages jsonb、created_at/updated_at；索引 user_id + updated_at 倒序；RLS select 按 user）|
| `0014_append_conversation_message.sql` | security-invoker 函数 `append_conversation_message(p_conversation_id, p_user_id, p_message, p_title)`：单条 UPDATE `messages || jsonb_build_array(p_message)` 原子追加（行级锁防多标签页并发丢消息），首条消息时用 `p_title` 填 title，`RETURNING messages` 返回权威数组；仅 service_role 可执行，owner 校验由 `where user_id = p_user_id` 承担 |

# WeatherMind 开发速览

面向开发人员的项目速览。先看「核心链路」流程图理解实现逻辑，再对照「代码地图」定位代码。

## 项目是什么

WeatherMind 是一个**多源天气仪表盘 + AI 当日预报 + AI 天气助手**：

- 每天定时从 Open-Meteo / OpenWeatherMap / WeatherAPI.com 三个数据源采集天气，归一化后写入 Supabase；
- 前端按「城市 × 数据源」展示实时天气卡片与近 7 天历史；
- 核心功能 **ForecastAgent**：用「确定性多源加权集成 + AI 自然语言解读」生成当日预报，先算后讲、结果可复现；
- **AI 助手对话**：与 ForecastAgent 共享同一套 AI 基建，支持自然语言问天气/历史/预报，拿到权威预报时自动下发 a2ui 指标卡。

技术栈：Next.js 16（App Router）+ React 19 + Tailwind 4 + shadcn/ui（@base-ui/react）+ pnpm + TS strict，仅浅色模式。
Supabase（认证 + Postgres + RLS）、TanStack Query/Form、Zod、next-intl（zh 默认无前缀，en 走 `/en`）、Vitest。

## 核心链路

### 1. 天气采集：数据从哪来

两个触发入口，共用同一管道 `runWeatherPipeline(trigger)`：

- **定时**：GitHub Actions 每日 15:00 UTC（JST 0 点）直跑 `scripts/weather-cron.ts`，不经部署环境；
- **手动**：预报页「刷新」按钮（仅管理员）→ `refreshWeatherAction`。

```mermaid
flowchart LR
    A["GitHub Actions 每日定时<br/>weather-cron.yml → scripts/weather-cron.ts"] --> P
    B["管理员点「刷新」<br/>refreshWeatherAction"] --> P
    P["runWeatherPipeline<br/>lib/weather/pipeline.ts"] --> C["读启用城市 cities.is_active"]
    C --> F["城 × 源 并发拉取<br/>providers/*"]
    F --> H["fetchJson 统一请求<br/>lib/weather/http.ts<br/>不抛错 / no-store / 可超时"]
    H --> Z["Zod safeParse 源响应"]
    Z --> M["归一化 NormalizedWeather<br/>mapping 条件码→粗分类<br/>daily 按城市时区归日"]
    M --> W["落库<br/>weather_current 实时 upsert<br/>weather_daily 每日快照 upsert"]
    W --> Cl["清理 7 天前快照"]
    Cl --> R["写 weather_runs 运行记录"]
```

要点：

- **加源易**：每源实现一个 `ProviderAdapter`（`source` / `fetchCurrentAndForecast` / `fetchDailyHistory`），注册进 `providers` 数组即可；
- **失败隔离**：单格失败只记一格（missingKey / network / http / parse / noData / db），整轮继续、绝不抛错；终态 success / partial / failed 写入 `weather_runs`；
- **写入端**：service_role 客户端（`supabase/service.ts`）绕过 RLS；手动触发经管理员白名单（`lib/weather/admin.ts`）。

### 2. ForecastAgent：当日预报怎么生成

**定位：不是通用聊天 agent，而是「确定性计算引擎 + AI 解读器」的分工。** 天气数值一律由数学内核产出（可复现、可单测、可审计），AI 只把指标翻译成自然语言——且运行在一个**受限的只读多 agent 编排**里：主管统筹、专家只回读内核数据（绝不计算），调用走 SSE 流式 + `temperature=0`，输出是纯 Markdown 文档。LLM 从根上无法编造数字。

**流式管道**（「写一次读多次」：首个用户点「预报当日」认领生成，其后任何人只读库；生成走 SSE 流式，用户能逐 token 看到推理过程与 Markdown 正文）：

```mermaid
flowchart LR
    U["用户点「预报当日」<br/>forecast-view.tsx → useForecastStream"] --> POST["POST /api/ai-agent/forecast<br/>route.ts 自鉴权 createClient + getUser"]
    POST --> ST["runForecastAgentStream<br/>lib/forecast-agent/stream/stream.ts"]
    ST --> R["readForecast<br/>城×日×语言"]
    R -->|"success / pending"| DUP["duplicate 事件<br/>直接返回，不重复生成"]
    R -->|"无"| CL["claimPending<br/>唯一键 城×日×语言"]
    R -->|"failed"| CD["冷却判定<br/>isWithinRetryCooldown<br/>失败后 5 分钟内禁重试"]
    CD -->|"冷却期"| CDERR["error: retry-cooldown"]
    CD -->|"已过冷却"| CL
    CL --> SI["buildSourceInputs<br/>各源快照（weather_daily + weather_current）"]
    SI --> W["computeWeights<br/>先验 + 一致性 + 真值MAE（α/β/γ）"]
    W --> PRED["predict 确定性集成<br/>engine/ensemble.ts"]
    PRED --> P["buildSupervisorMessages<br/>指标表 + 铁律 + 委托指令"]
    P --> RL["runSupervisedStream<br/>lib/agent-core/orchestrator.ts<br/>主管 + 专家 reconcile/risk ≤4 步"]
    RL --> VAL["validateMarkdownDoc<br/>两段齐全 + 数值容差"]
    VAL -->|"过"| OK["settle success<br/>指标 + markdown_body + react_trace + token"]
    VAL -->|"拒"| ERR["落 failed + failed_at<br/>error 事件"]
```

**逐步拆解**（核心流式状态机见 `lib/forecast-agent/stream/stream.ts`，DB 原语见 `db/db.ts`）：

1. **读既有**（`readForecast`）——按 城×日×语言 查预测行：success/pending 直接返回 duplicate 事件，不重复生成；
2. **失败冷却**（`db/db.ts` `isWithinRetryCooldown`）——failed 行距失败时刻 <5 分钟时返回 `retry-cooldown`，防失败重试无限刷服务器（正常使用不限次数，已生成过的直接读库）；冷却过后转认领重试；
3. **认领 pending 行**（`claimPending`）——insert 命中唯一键 (city_id, day, locale)；`23505` 冲突说明已被他人认领，读回现有行；存量 failed 行转回 pending 并清 `failed_at`/`error_code` 重新生成；生成失败统一落库为 `failed` + `failed_at`（供冷却计时），不再删除；
4. **取当日各源快照**（`buildSourceInputs`）——高/低/降水/条件取 `weather_daily`，湿度/风取 `weather_current` 当日快照（缺则 null，集成自动跳过）；
5. **源数校验**——当日数据源 <2 视为无效，返回 `insufficient-data`，不给出确定性结论；
6. **权重合成**（`engine/weights.ts` `computeWeights`）——`先验 PRIOR + 近 6 天一致性分（留一法偏离度）+ 真值 MAE` 三层合成，按真值天数用 α/β/γ 过渡：<7 天几乎全依赖先验 + 一致性，≥30 天 MAE 主导；
7. **确定性集成**（`engine/ensemble.ts` `predict`，全部纯函数、可单测）——
   - 加权均值：高温 / 低温 / 降水 / 风 / 湿度；
   - 降水概率：报雨（日降水 ≥0.1mm）源的权重占比（0-100）；
   - 天气状况：加权多数投票（跳过条件缺失的源）；
   - 预测区间：均值 ± 1.28×加权标准差（≈80% 置信）；
   - 置信度：多数派权重占比（high ≥75% / medium ≥50% / low），不依赖历史真值；
   - 风险标记：阈值（高温 ≥35°C / 低温 ≤0°C / 强降水 ≥25mm / 风 ≥6 级 / 雷暴 / 降雪 / 温差 ≥10°C）+ 至少 2 源一致才标，防单源误报；
8. **拼提示词**（`agent/prompt.ts`，按 agent 拆分）——见下「Prompt 工程」；
9. **多 agent 流式编排**（`lib/agent-core/orchestrator.ts` `runSupervisedStream`）——主管 supervisor 跑一个 ReAct 循环，每位专家（reconcile 源核对 / risk 风险解读）被包装成 `delegate_<agentId>` 工具注入主管工具列表；主管调 delegate 即触发专家完整执行，观察 = 专家最终内容；每步发起 `chatCompletionStream` 流式调用（`lib/agent-core/chat-stream.ts`：SSE，provider 忽略 stream 时降级单帧 JSON；`temperature=0`、可超时）。**只流式主管的 delta/rollback**，专家内容以 delegate 观察呈现，不污染最终 Markdown；断线 `signal` 透传给主管与专家各自的循环；
10. **信任边界校验**（`lib/schemas/forecast-agent.ts` `validateMarkdownDoc`）——全文流完后跑轻量文本校验（见下）；
11. **settle 落库**——success 写全部指标 + `markdown_body` + `react_trace` + token 用量；任一步失败统一落库为 `failed` + `failed_at`（失败冷却计时）并发出带内 `error` 事件；客户端中途断线（AbortSignal 中止）在 `finally` 删除 pending 行，保证当日 城×日×语言 永不被卡死。

**工具**（`agent/tools.ts`）——单个只读工具，模型查看指标表之外数据的唯一窗口；只回读确定性内核算出的数据，AI 不引入任何新数值（参数用 JSON-schema + Zod 双校验）：

- `query_source(source)` — 返回某数据源的原始预报快照（高/低/降水/条件/湿度/风）。`get_metric` 已随提示词精简移除——user 消息的指标表已含全部权威值，原样再查一遍纯属重复。

**源间分歧检测**（`engine/divergence.ts`）——对各源输入做纯函数判定：降水分歧（湿/干两组）、条件分歧（非空类别 >1 组）、温差分歧（高/低 spread ≥3°C）。有分歧时提示词注入「必须逐源 query_source 核对后再定稿」的强制指令，驱动分歧日真正产生工具步骤（工具成为承重墙）。

**Prompt 工程**（`agent/prompt.ts`，按 agent 拆分为三个构建函数）——整份上下文（指标表 / 权重行 / ReAct 协议 / 分歧块 / 铁律）**按当前语言组装**，防止英文界面下模型被中文数据表带偏、顺着输出中文：

- **主管 `buildSupervisorMessages(ctx)`**——任务层硬性要求先调 `delegate_reconcile`/`delegate_risk` 再定稿（确定性委托）；输出契约仅 `## 推理过程` + `## 预报` 两段；
- **源核对专家 `buildReconcileMessages(ctx)`**——只读约束 + 分歧块强制 `query_source` 逐源核对；输出供主管引用的结论；
- **风险解读专家 `buildRiskMessages(ctx)`**——只解读 risk_flags、不得虚构；无工具；
- **输出契约**：只输出一份 Markdown 文档，含且仅含两个二级标题段、顺序固定——`## 推理过程`（en 为 `## Reasoning`）在前，`## 预报`（en 为 `## Forecast`）在后；预报正文用 2~3 句叙述（总览 + 行动建议），必须包含预测高温/低温（°C）与降水概率（%），但不逐条罗列指标表；
- **铁律**：数值只来自指标表（绝不编造/改口径）；有风险标记必须提及、无风险不得虚构或使用「高风险/预警」措辞；不质疑/贬低平台指标，只解释与建议。

**防幻觉兜底：Markdown 校验**（`validateMarkdownDoc`）——全文流完后做的机器校验，任一不过回滚该行并发出 `error: consistency`：

- 两段齐全且推理在前、预报在后；
- 预报段含与集成 high/low 差 ≤2.5°C 的温度值、PoP 差 ≤10 的百分比值（PoP=0 时「无降水」类措辞即可）；
- 防胡编：温度都在 −40~60°C 内、百分比 ≤100；
- 注意与旧结构化输出的反转：预报正文必须含温度数字，因此不再禁温度单位。

**为什么用受限多 agent 编排而非单次调用**：预报数字是「事实」，必须保持可复现、可审计，故绝不要求模型计算——工具只用于让它核对源级事实（分歧日强制）。循环有上限（主管 4 步、无网络/搜索工具），不会滑向开放式工具滥用。未来若要让 agent 自主查补充数据，可在 `buildTools` 注册更多工具——但当前内核已覆盖全部展示指标。

其他要点：

- **权重自校准**：真值由每日 cron 拉三源历史观测取中位数落 `weather_truth`（`engine/truth.ts` `backfillTruth`，只保留近 31 天），攒够天数后权重自动偏向 MAE 更小的源；
- **模型配置**：用户自带 OpenAI 兼容 baseUrl/key，按邮箱存 localStorage（`lib/model-config.ts`），服务端每次调用前做 SSRF 防护（仅 https + IPv4/IPv6 私网/保留段拦截 + DNS 复核，见 `lib/agent-core/ssrf.ts` + `dns.ts`）；
- **时区不变量**（迁移 `0011_city_timezone_check.sql`）：权重窗口 / 真值轮换均按 Asia/Tokyo 硬编码，故 `cities.timezone` 用 CHECK 约束为 `'Asia/Tokyo'`，防未来新增非东京城市破坏日期对齐；
- **流式 + 断线安全**：SSE 生成器透传客户端 AbortSignal；断线或未预期异常由 `finally` 兜底删除仍为 pending 的行，保证同一 城×日×语言 随时可重试。

### 2.5 AI 助手对话（ai-agent）：自然语言问天气

**定位：与 ForecastAgent 同源的天气问答 Agent。** 两者共享 `lib/agent-core/` 底层（chat 调用 + ReAct 循环）；AI 助手的 `generate_forecast` 工具把「生成当日预报」委托给 ForecastAgent 子 Agent，主 Agent 自己负责查城市/读数据/编排回答。拿到权威预报时，服务端自动模板化下发 a2ui 指标卡，正文只写简洁叙述、不重复指标表。

```mermaid
flowchart LR
    U["用户在聊天框提问<br/>chat-panel → useChatStream<br/>(useSseStream 传输层)"] --> POST["POST /api/ai-agent/chat<br/>route.ts 自鉴权 requireUser"]
    POST --> A["append_conversation_message RPC<br/>用户消息原子追加落库<br/>（单条 UPDATE，防多标签页并发丢消息）"]
    A --> RL["主 Agent ReAct 循环<br/>runReActLoopStream maxSteps 6<br/>tools：query_city / query_sources /<br/>query_weather_history / query_forecast / generate_forecast"]
    RL --> OB["reduceToolEvent 累积工具观察<br/>（城市名 + 预报指标）"]
    OB --> CARD["成功预报 → done 前发 a2ui 卡片消息"]
    CARD --> SAVE["assistant 回复先落库<br/>（同一 RPC，带 usage 与 a2ui）再发 done"]
    SAVE --> SSE["SSE 事件流回前端<br/>delta / rollback / a2ui / done / error"]
```

**要点**：

- **共享底层**：主 Agent 与 ForecastAgent 都用 `lib/agent-core/` 的 chat 原语、ReAct 循环与 SSRF 防护，工具定义不重复；
- **五个工具**（`lib/ai-agent/agent/tools.ts`）：`query_city`（ILIKE 搜城市，转义 PostgREST 分隔符）、`query_sources`（当日各源快照）、`query_weather_history`（近 7 天历史，上限与平台保留窗口一致）、`query_forecast`（读今日权威预报）、`generate_forecast`（**异步委托子 Agent**，消费 `runForecastAgentStream`，无 email 拒绝——认领需 created_by）；
- **会话持久化**：`ai_conversations` 表（user_id 隔离 + messages jsonb），消息经 RPC `append_conversation_message` 原子追加（单条 UPDATE 行级追加，防多标签页读改写丢消息）；工具过程不落库，历史只含 user/assistant；
- **只显示最终回答**：路由只转发 delta/rollback/done/error，工具步的 thought/tool 消费不转发（思考文字经 rollback 回滚）；`request.signal` 透传——客户端断开即中止在途 LLM 调用省 token，回复不落库（只保留用户消息）；
- **a2ui 卡片**：`lib/ai-agent/a2ui/forecast-card.ts` 把工具观察模板化成 v0.9 卡片消息（createSurface → updateComponents → updateDataModel），前端 `A2uiCard` 渲染 MetricTile 指标磁贴；模型不生成 UI、不转述数值，卡片只回读工具观察。

### 3. 请求与认证：谁能看什么

```mermaid
flowchart LR
    REQ["浏览器请求"] --> PROXY["proxy.ts 根中间件<br/>next-intl locale 协商"]
    PROXY --> SESS["supabase/proxy.ts updateSession<br/>刷新认证 Cookie（过期自动续期）"]
    SESS --> GUARD{"登录态?"}
    GUARD -->|"未登录且非白名单（/ login /register /forgot-password）"| REDIR["303 重定向到落地页"]
    GUARD -->|"已登录"| DASH["/dashboard 及子页"]
    DASH --> RSC["Server Component 会话读<br/>supabase/server.ts createClient"]
    DASH --> ACT["Server Action<br/>二次鉴权（管理员 / 邮箱）"]
```

- 写路径统一 service_role 绕过 RLS（`supabase/service.ts`，**仅服务端 import**）；读路径走 authenticated 角色 + RLS（0003_rls.sql）；
- 管理员门禁双保险：展示层隐藏按钮 + 动作层拒绝直调（`lib/weather/admin.ts`）；
- `/api` 路由不走 proxy 中间件，自行鉴权：`app/api/ai-agent/forecast` 与 `app/api/ai-agent/chat` 都用公共 `requireUser`（`createClient` + `getUser`），并在流开始前服务端重新校验模型配置 schema（流开始前失败返回非 2xx JSON；流开始后错误走带内 SSE 事件）。

## 代码地图（路径 — 功能）

### 认证

- `proxy.ts` — 根中间件：locale 协商 + 会话刷新 + 路由守卫
- `supabase/proxy.ts` — `updateSession`：在响应上同步认证 Cookie、过期自动续期
- `supabase/server.ts` — `createClient`：服务端会话客户端（RSC / Server Action）
- `supabase/service.ts` — `createServiceClient`：service_role 客户端，绕过 RLS（服务端专用）
- `supabase/auth/actions.ts` — 登录 / 两段式注册 / 忘记密码 Server Action
- `supabase/auth/errors.ts` — `mapAuthError`：Supabase 错误 → 受限错误码
- `lib/schemas/auth.ts` — 认证表单 Zod schema

### 天气采集管道

- `lib/weather/pipeline.ts` — 主入口：`runWeatherPipeline`（采集）/ `runWeatherBackfill`（历史回填）；城×源并发、落库、清理、写运行记录，恒不抛错
- `lib/weather/http.ts` — `fetchJson` / `fetchStream`：唯一 fetch 封装（先判 `res.ok`、`cache:no-store`、可超时、绝不抛错；`fetchStream` 不读 body——调用方用 `response.body.getReader()` 消费 SSE，并设 `redirect:manual` 防 SSRF 跳转）
- `lib/weather/providers/index.ts` — `ProviderAdapter` 契约 + 三源注册表
- `lib/weather/providers/open-meteo.ts` — 免 key 源 adapter（naive 本地时间转 UTC）
- `lib/weather/providers/openweather.ts` — OpenWeatherMap adapter
- `lib/weather/providers/weatherapi.ts` — WeatherAPI.com adapter（km/h → m/s）
- `lib/weather/mapping.ts` — 各源条件码 → 8 个粗分类、单位换算
- `lib/weather/sse.ts` — SSE 帧解析纯函数（`splitSseEvents` / `extractDataPayloads` / `isDonePayload`），AI provider 流与前端 hook 共用
- `lib/weather/daily.ts` — 按城市时区归日、当日快照聚合、窗口工具
- `lib/weather/actions.ts` — `refreshWeatherAction` / `backfillWeatherAction`（管理员手动触发）
- `lib/weather/admin.ts` — 管理员白名单（`isAdminEmail`）
- `lib/weather/city-actions.ts` — 城市增删（管理员 + service 写入，FK cascade 清数据）
- `lib/weather/resolve-city.ts` — `?city=` 参数解析为唯一城市并补齐重定向
- `lib/weather/pagination.ts` — `fetchPage`：对 Supabase 查询追加 `range` 返回该页 rows + total（城市/日志服务端 URL 分页）
- `lib/weather/view-types.ts` — 展示层 DB 行类型断言（无生成的 Database 类型）
- `lib/weather/errors.ts` — 动作错误码类（WeatherError / CityError）

### 共享 AI/ReAct 基建（`lib/agent-core/`，两个 Agent 共用）

- `chat.ts` — OpenAI 兼容 chat 原语：`assertPublicBaseUrl`（SSRF 前置）、wire 消息/工具互转、请求体构建、响应解析
- `chat-stream.ts` — `chatCompletionStream`：流式 chat（SSE / 单帧 JSON 降级）+ 事件 delta/tool/done
- `react.ts` — ReAct 内核：`safeParseJson` / `mergeUsage` / `executeToolCalls`（坏调用喂回自纠错）
- `react-stream.ts` — `runReActLoopStream`：流式 ReAct 循环（delta / thought / rollback / tool / result，支持 signal 取消）
- `orchestrator.ts` — `runSupervisedStream`：通用「主管 + 专家」多 agent 编排（专家包装成 `delegate_<agentId>` 工具，事件带 agentId，只流式主管 delta）
- `ssrf.ts` — SSRF 防护（仅 https + 私网/保留段拦截 + DNS 复核）
- `dns.ts` — DNS 解析唯一入口（`resolveHostAll`，供测试 mock）

### 数据模型（前后端共享 Zod）

- `lib/schemas/weather.ts` — canonical `NormalizedWeather`（时间 UTC ISO、单位公制、条件码保留原值 + 粗分类）
- `lib/schemas/city.ts` — 城市表单 schema
- `lib/schemas/forecast-agent.ts` — 预测行类型、`METRICS` 指标 id 常量、ReAct 轨迹 schema（含 agent_id）、Markdown 校验（`validateMarkdownDoc`）
- `lib/schemas/agent-core.ts` — 通用 AI wire schema（`chatResponseSchema` / `chatUsageSchema`，外部 AI 响应）
- `lib/schemas/ai.ts` — 模型配置 schema、`/models` 响应 schema
- `lib/schemas/ai-agent.ts` — 会话消息 / 聊天请求体 / 删除会话 schema
- `lib/schemas/a2ui.ts` — a2ui v0.9 卡片消息信封 schema（zod v4）
- `lib/schemas/a2ui-catalog.ts` — MetricTile 组件 schema（zod v3，与 @a2ui/web_core 运行时同源）
- `lib/schemas/pagination.ts` — `?page=` 归一化 schema + `totalPages`（前后端共用）

### ForecastAgent

- `app/api/ai-agent/forecast/route.ts` — 流式端点：POST → SSE（`runForecastAgentStream`）；`createClient` + `getUser` 自鉴权，服务端重校验模型配置，透传客户端 AbortSignal
- `lib/forecast-agent/stream/stream.ts` — `runForecastAgentStream`：唯一生成入口（SSE 事件异步生成器）；读 → 认领 → 集成 → 多 agent 编排 → 校验 → settle，失败回滚删 pending 行
- `lib/forecast-agent/db/db.ts` — 持久化原语：`readForecast` / `claimPending`（23505 读回；存量 failed 转 pending）/ `settleRow` / `buildSourceInputs` / `isWithinRetryCooldown`（5 分钟）
- `lib/forecast-agent/engine/ensemble.ts` — 确定性集成：加权均值 / 降水概率 / 多数投票 / 区间 / 置信度 / 风险标记
- `lib/forecast-agent/engine/weights.ts` — 源权重：先验 + 一致性 + 真值 MAE 合成与 α/β/γ 过渡（窗口按 Asia/Tokyo 对齐）
- `lib/forecast-agent/engine/divergence.ts` — 源间分歧检测（降水 / 条件 / 温差），提示词强制 query_source 核对
- `lib/forecast-agent/engine/truth.ts` — 参考真值回填（三源历史中位数 → `weather_truth`，只留近 31 天）
- `lib/forecast-agent/agent/prompt.ts` — 按 agent 拆分：`buildSupervisorMessages` / `buildReconcileMessages` / `buildRiskMessages` + 共享 `buildContext` / `divergenceBlock` / `formatMetricValue`
- `lib/forecast-agent/agent/prompt-text.ts` — 提示词本地化文案表 `TEXTS`（zh/en）
- `lib/forecast-agent/agent/specialists.ts` — 专家团注册：`buildSupervisorConfig` / `buildReconcileSpecialist` / `buildRiskSpecialist`
- `lib/forecast-agent/agent/tools.ts` — 只读工具注册表：`query_source`（参数 JSON-schema + Zod 双校验）
- `lib/forecast-agent/common/errors.ts` — `ForecastAgentErrorCode` 外部契约（no-model / retry-cooldown / insufficient-data / provider / parse / consistency / react-loop / generic）
- `lib/model-config.ts` — 模型配置 localStorage 读写（按邮箱隔离）+ 调 `/models` 列表

### AI 助手对话

- `app/api/ai-agent/chat/route.ts` — 聊天流式端点：`requireUser` 鉴权 → 校验请求体 → 原子追加用户消息 → 主 Agent ReAct 循环（maxSteps 6）→ 工具观察累积 → 回复落库 + a2ui 卡片 → SSE 流回
- `lib/ai-agent/agent/prompt.ts` — 主 Agent 系统提示词（身份 / 意图分流 / 铁律）+ 历史转 wire
- `lib/ai-agent/agent/tools.ts` — 主 Agent 工具：`query_city` / `query_sources` / `query_weather_history` / `query_forecast` / `generate_forecast`（委托子 Agent）
- `lib/ai-agent/a2ui/forecast-card.ts` — 权威工具观察 → a2ui 卡片消息模板化（`buildForecastCardMessages`）
- `lib/ai-agent/a2ui/capture.ts` — 流式循环内工具观察累积（`reduceToolEvent`）
- `lib/ai-agent/common/route-helpers.ts` — `requireUser` / `readJsonBody` / `createSseResponse` / `SSE_RESPONSE_HEADERS`
- `lib/ai-agent/common/chat-events.ts` — 聊天 SSE 事件契约 `ChatSseEvent`
- `lib/ai-agent/common/errors.ts` — 会话动作错误码（`ConversationActionErrorCode`）
- `lib/ai-agent/db/conversation-actions.ts` — 会话增删 Server Action

### 页面与组件

- `app/[locale]/dashboard/ai-agent/page.tsx` — AI 助手页 RSC：会话列表 + 当前会话初始消息，`?id=` 补齐重定向
- `app/[locale]/dashboard/ai-agent/setup/page.tsx` — 未配置模型提示页（客户端重定向至此）
- `components/dashboard/ai-agent/` — 聊天视图：`ai-agent-view`（主视图）/ `conversation-list`（会话栏）/ `chat-panel`（消息流 + 输入）/ `message-bubble` / `a2ui-card`（渲染 a2ui 卡片）/ `a2ui-catalog`（MetricTile catalog）
- `app/[locale]/dashboard/forecast/page.tsx` — 预报页 RSC：查单城当前天气 + 最近运行（不预载预报行——由客户端流式拉取）
- `components/dashboard/forecast/forecast-view.tsx` — 预报页客户端视图：城市切换 / 刷新 / 经 SSE 流触发 ForecastAgent
- `components/dashboard/forecast/forecast-agent-card.tsx` — 结果卡片：指标图标卡 + 流式 Markdown 正文（`## 推理过程` / `## 预报`）；旧结构化行兜底 summary/points/advice
- `components/dashboard/forecast/forecast-metrics-grid.tsx` — 9 张权威指标图标卡（高/低/降水概率/等级/状况/风/湿度/置信度/风险）
- `components/dashboard/forecast/forecast-reasoning-card.tsx` — 多 agent 推理轨迹卡（按 `agent_id` 分组渲染），流式实时出现
- `components/ui-preset/forecast-card-shell.tsx` — 共用卡片外壳（色调 / 状态圆点 / 阶段指示）
- `components/ui-preset/markdown.tsx` — Markdown 渲染预设（react-markdown + remark-gfm），shadcn token 样式
- `hooks/use-sse-stream.ts` — 通用 SSE 传输层 hook（状态机 + AbortController + 错误码映射），`useForecastStream` / `useChatStream` 共用
- `hooks/use-forecast-stream.ts` — 预报流 hook（`delta`→Markdown、`thought`/`tool`→轨迹步、`rollback` 回滚、`duplicate`/`done` 定稿重分组）
- `hooks/use-chat-stream.ts` — 聊天流 hook（`delta` 累积 / `rollback` 回滚 / `a2ui` 暂存 / `done` 收尾）
- `hooks/use-model-config.ts` / `hooks/use-element-height.ts` — 模型配置订阅 / 左卡高度观测
- `hooks/use-paginated-navigation.ts` — 服务端 URL 分页导航（写查询串后 router.push，保留 baseQuery）
- `app/[locale]/dashboard/history/page.tsx` — 历史页 RSC：近 7 天每日快照
- `components/dashboard/history/history-view.tsx` — 历史表格 + 图表
- `app/[locale]/dashboard/cities/page.tsx` — 城市列表页（`?page=` 分页）；`components/dashboard/cities/*` — 列表 + 增删对话框
- `app/[locale]/dashboard/logs/page.tsx` — 采集日志页（管理员，`weather_runs` 分页）；`components/dashboard/logs/logs-view.tsx`
- `app/[locale]/dashboard/settings/page.tsx` — 设置页；`components/dashboard/settings/model-config-card.tsx` — 模型配置表单
- `app/[locale]/dashboard/page.tsx` + `components/dashboard/home/dashboard-home-view.tsx` — 首页总览（欢迎横幅 + 功能入口卡片）
- `components/ui-preset/data-table.tsx` / `table-pagination.tsx` — 通用只读表格 + 分页条（固定每页 20）
- `app/[locale]/dashboard/layout.tsx` — 仪表盘布局（侧边导航 + 登录守卫）
- `i18n/routing.ts` — next-intl 路由（zh 默认 / en）

### 定时任务与 CI

- `scripts/weather-cron.ts` — Actions 每日采集入口：跑管道 + 清空预测 + 回填真值，全败退出非零标红
- `.github/workflows/weather-cron.yml` — 每日 15:00 UTC（JST 0 点）注入 secrets 跑采集
- `.github/workflows/ci.yml` — typecheck / lint / build + 覆盖率测试上报 Codecov
- `.github/workflows/stryker.yml` — PR 定向变异测试（只变异「有测试」的变更文件）

### 数据库（`supabase/migrations/`，按序执行）

- `0001_weather.sql` — cities / weather_current / weather_runs + 8 个日本城市种子
- `0002_weather_daily.sql` — 每日快照表（城×源×日唯一）
- `0003_rls.sql` — 启用 RLS：authenticated 只读
- `0004_remove_weather_forecast.sql` — 仅旧库：删除废弃的 weather_forecast 表
- `0005_email_registered.sql` — `is_email_registered` RPC（注册预检，service_role 可调）
- `0006_forecast_agent.sql` — 预测表（城×日唯一）+ 真值表
- `0007_forecast_agent_locale.sql` — 预测加 locale，唯一键改 城×日×语言
- `0008_forecast_agent_tokens.sql` — 预测加 token 用量列
- `0009_forecast_agent_react_trace.sql` — 预测加 `react_trace` jsonb（ReAct 思考/动作轨迹，步骤含 agent_id）
- `0010_forecast_agent_markdown.sql` — 预测加 `markdown_body` text（纯 Markdown 输出全文；旧结构化行保持 null）
- `0011_city_timezone_check.sql` — `cities.timezone` CHECK = `'Asia/Tokyo'`（时区不变量：权重窗口 / 真值轮换均按东京硬编码）
- `0012_forecast_agent_failed_at.sql` — 预测加 `failed_at`（失败冷却计时，替代原每日配额）
- `0013_ai_conversations.sql` — `ai_conversations` 会话表（user_id 隔离 + messages jsonb，RLS select 按 user）
- `0014_append_conversation_message.sql` — `append_conversation_message` 原子追加消息 RPC（单条 UPDATE 行级追加，防并发丢消息）

## 快速开始

```bash
pnpm install
cp .env.example .env.local   # 填 Supabase 连接与数据源 key，见下
```

1. Supabase Dashboard → SQL Editor 按 0001 → … → 0014 顺序执行迁移；
2. `pnpm dev` 启动，注册账号进入仪表盘；在「设置」配置 OpenAI 兼容模型后即可用 ForecastAgent 生成预报，或进入「AI 助手」自然语言对话；
3. 校验：`pnpm typecheck` / `pnpm lint` / `pnpm test`（CI 见 `.github/workflows/ci.yml`）。

### 环境变量

| 变量 | 用途 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 连接（公开，受 RLS） |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role 服务端密钥，管道写入 / 城市增删用；**勿加 `NEXT_PUBLIC_`、勿在客户端 import** |
| `OPENWEATHER_API_KEY` | OpenWeatherMap 数据源（服务端） |
| `WEATHERAPI_API_KEY` | WeatherAPI.com 数据源（服务端） |

## 关键约定

- 错误模式：服务端动作 / 管道返回结果对象与受限错误码，**不抛错跨 RPC**；客户端 `!ok` 抛对应 Error 类驱动 toast
- Zod 只在信任边界（外部响应 / 表单 / 路由入参），`safeParse` 优先；内部可信数据不解析
- 网络请求统一走 `lib/weather/http.ts` `fetchJson` / `fetchStream`
- 写路径 service_role、读路径 authenticated + RLS；`supabase/service.ts` 仅服务端 import
- 文案进 `i18n/messages/{zh,en}.json`；URL 跳转用 `@/i18n/navigation` 的 `Link` / `useRouter`
- 逻辑代码配简体中文注释；提交用 Conventional Commits

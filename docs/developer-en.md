# WeatherMind — Module Developer Reference

This document is a file-level map: for each module it lists what each file does and the purpose of its key functions/methods. Meant for humans.
It complements `quickstart-en.md` (core flows): here you get the "file map", there you get the "pipeline walkthrough".

> Maintenance: keep this file in sync whenever code changes (see `.claude/rules/docs-sync.md`). Agents must not treat it as an implementation source of truth.

---

## 0. Overview

```
app/[locale]/           Pages (zh default, no prefix; en at /en)
app/api/ai-agent/       Route Handler (/api bypasses the proxy middleware, self-authenticates)
components/             Components (dashboard / auth / notlogin / ui-preset / ui)
hooks/                  React hooks (streamed forecast / model config / element height)
i18n/                   next-intl routing and messages
lib/weather/            Weather ingestion pipeline (providers → http → pipeline → persistence)
lib/agent-core/         Shared AI/ReAct infrastructure (chat calls + ReAct loop + SSRF, used by both agents)
lib/forecast-agent/     Deterministic ensemble engine + AI interpretation (streamed ReAct)
lib/ai-agent/           AI assistant chat (main-agent prompt/tools + conversation persistence + chat SSE)
lib/schemas/            Zod trust-boundary schemas (shared client/server)
lib/model-config.ts     AI model config (per-email localStorage)
supabase/               Supabase clients (session / trusted writes / proxy refresh) and auth actions
supabase/migrations/    DB migrations (0001–0014)
scripts/weather-cron.ts GitHub Actions daily ingestion entry
proxy.ts                Root middleware (intl negotiation + session refresh + route guard)
```

---

## 1. `lib/weather/` — Weather ingestion pipeline

Collects from three providers (Open-Meteo / OpenWeatherMap / WeatherAPI.com), normalizes, and persists. Entry points: `runWeatherPipeline` / `runWeatherBackfill`.

### `http.ts` — the single network wrapper
Every weather/AI request in the project goes through this fetch wrapper (no axios/ky).
- `fetchJson(url, init?, timeoutMs?)` — fetch and parse JSON; network errors map to `network`, non-2xx to `http`, **never throws**; `no-store`, optional `AbortSignal.timeout`
- `fetchStream(url, init?, timeoutMs?)` — streaming fetch (AI/SSE); does not read the body; `redirect:"manual"` blocks redirect following (SSRF); missing body maps to `network`
- Signal merge: the external `init.signal` (client disconnect) and `timeoutMs` are combined with `AbortSignal.any`; either one aborting cancels the request. When only one is present it is passed through, and when neither is present no signal is set (`fetchJson` follows the same rule)

### `pipeline.ts` — pipeline orchestrator
- `runWeatherPipeline(trigger)` — main entry: active cities × every source, concurrent fetch → persist → prune snapshots older than 7 days → write `weather_runs`; per-cell failure isolation, never throws, returns `RunSummary`
- `runWeatherBackfill(days)` — history backfill: writes `weather_daily` only (temperature = high/low mean), filters to the city-timezone window, no window pruning
- Internals: `writeCell` (current + daily upsert), `writeDailyRow` (today snapshot, falls back to realtime when today's forecast slot is missing), `writeBackfillDay`, `cleanupAfterRun`, `openRun` / `finalizeRun`
- Types: `RunSummary`, `RunStatus` (success/partial/failed), `CellError`

### `daily.ts` — city-timezone date utilities (pure functions)
- `toLocalDateKey(iso, timeZone)` — UTC ISO → local `YYYY-MM-DD` for a timezone (`Intl.formatToParts`, stable across environments)
- `aggregateDailyForecast(timeZone, forecast)` — bucket forecast slots by city-local day (high/low/precip; condition from the hottest slot)
- `todayAggregate(timeZone, fetchedAt, forecast, current)` — today's snapshot aggregate; realtime fallback when today's forecast slot is missing
- `daysAgoLocalDateKey(timeZone, days, now?)` / `recentWindow(timeZone, days, now?)` — local date key N days back / backfill window

### `mapping.ts` — condition code → normalized category (pure functions)
- `mapWmoCode(code)` — Open-Meteo/WMO codes → `clear/partlyCloudy/cloudy/fog/rain/snow/storm/other`
- `mapOwmCode(code)` — OpenWeatherMap codes (partitioned by id prefix)
- `mapWeatherApiCode(code)` — WeatherAPI.com codes (enumerated, coarse)
- `kphToMps(kph)` — WeatherAPI km/h → m/s

### `view-types.ts` — display-layer DB row types
Types only. Defines `CityRow` / `CurrentRow` / `DailyRow` / `RunRow` / `TruthRow` (snake_case matching migrations); `ForecastRow` re-exports from `schemas/forecast-agent.ts` (single source, no drift).

### `resolve-city.ts` — city param resolution (server)
- `resolveCityParam(cities, rawCity, pathname)` — resolve `?city=` to one city: case-insensitive `name_en` match, fallback Tokyo, then first; redirects to the canonical URL when missing/invalid

### `pagination.ts` — Supabase paged fetch (server)
- `fetchPage<T>(query, page, pageSize)` — appends `range` to a query already configured with `select("*", { count: "exact" })` + `order`, returns the page's `rows` with `total`/`totalPages` (types `PageMeta`/`PageResult<T>`); falls back to row count when `count` is missing
- Structural `range`-only typing: the project has no generated DB types (untyped client), so it avoids hard-coding Postgrest generics
- Used by the cities/logs pages for server-side URL pagination (fixed page size of 20); the history page's small dataset does not use it

### `actions.ts` — manual-trigger Server Actions ("use server")
- `refreshWeatherAction()` — admin manual refresh; runs the full pipeline and returns the summary
- `backfillWeatherAction(days=7)` — admin manual backfill; days clamped to 1–30
- Both check `getUser` + `isAdminEmail` whitelist; return limited error codes instead of throwing

### `city-actions.ts` — city create/delete Server Actions ("use server")
- `createCityAction(values)` — schema first → admin gate → service-client write; unique conflict maps to `duplicate`
- `deleteCityAction(values)` — hard delete, FK cascade clears the city's weather; 0 rows deleted maps to `notFound`
- Internal `requireAdmin()` — session + whitelist gate

### `admin.ts` — admin whitelist
- Constant `ADMIN_EMAIL`; `isAdminEmail(email)` — lowercase/trim comparison

### `errors.ts` — limited error codes
- Types `WeatherErrorCode` / `CityErrorCode`; classes `WeatherError` / `CityError` (carry `code` for client i18n lookup)

### `sse.ts` — SSE frame parsing (pure functions)
- `splitSseEvents(buffer)` — split into complete `\n\n`-delimited blocks (`\r\n` tolerant), returns `{blocks, rest}`
- `extractDataPayloads(block)` — strip `data:` prefix, support multi-line data
- `isDonePayload(payload)` — detect the `[DONE]` sentinel

### `providers/index.ts` — adapter contract and registry
- Types `ProviderAdapter` (`source` / `fetchCurrentAndForecast` / `fetchDailyHistory`), `AdapterErrorCode`, `HistoryDay`
- Constant `providers` = [openMeteo, openWeather, weatherApi]; implement the contract and register to add a source

### `providers/open-meteo.ts` — Open-Meteo adapter
Keyless, single call returning current + hourly. Internals: `toUtcIso` (naive local time → UTC via offset, environment-timezone independent), `mapCurrentPoint` / `mapForecastItems` (skip/null when required fields are missing), `buildParams`; `fetchDailyHistory` uses `past_days` and re-aggregates hourly by day.

### `providers/openweather.ts` — OpenWeatherMap adapter
Realtime `/weather` + forecast `/forecast` in parallel (`units=metric`); history backfill uses One Call 3.0 `day_summary` per day (no condition field → condition* set to null).

### `providers/weatherapi.ts` — WeatherAPI.com adapter
Realtime `/current` + forecast `/forecast(days=3)` in parallel; km/h → m/s; history uses `history.json` per day, using the caller's local date key (never trusts the source's naive date).

---

## 2. `lib/agent-core/` — shared AI/ReAct infrastructure (used by both agents)

OpenAI-compatible chat calls + ReAct loop + SSRF protection, with no agent-domain logic; shared by forecast-agent / ai-agent.

### `chat.ts` — OpenAI-compatible chat shared primitives
- `assertPublicBaseUrl(baseUrl)` — SSRF preflight (literal whitelist + DNS recheck), returns error code or null
- `buildChatRequestBody(params, stream)` — wire body (`temperature:0`, optional tools, stream flag)
- `toWireMessage` / `toWireTool` — internal messages/tools → OpenAI wire shape
- `parseChatMessage(msg)` — flatten wire response to `{content, toolCalls}`
- Types: `ChatMessage` (system/user/assistant/tool), `ChatTool`, `ProviderErrorCode`

### `chat-stream.ts` — streaming chat call
- `chatCompletionStream(params, opts?)` — same SSRF preflight as chat; dispatches by Content-Type: SSE stream / single-frame degrade for `application/json` / parse otherwise. Yields `ChatStreamEvent` (`delta` / `tool` / `done`); `opts.signal` is forwarded to fetch (aborts the in-flight call on disconnect)
- Internal `readSseChatStream` — reads the upstream stream block by block, accumulates tool_calls by index (**id/name assigned on first occurrence, arguments appended across frames** — some compatible endpoints repeat the full id/name on every frame and appending would concatenate duplicates), takes usage from any frame; skips bad frames; cancels the reader when the consumer breaks early

### `react.ts` — shared ReAct kernel
- `safeParseJson(s)` — strict JSON.parse wrapper
- `mergeUsage(a, b)` — accumulate usage across steps
- `executeToolCalls(tools, toolCalls)` — asynchronously execute tool calls and build tool messages (`ReactTool.execute` may return a Promise; the main agent's generate_forecast delegates to the sub-agent, a long-running op); bad calls do not abort (the error observation is fed back for self-correction); empty / literal `null` arguments are treated as `{}` (fallback for parameterless delegate tools)
- Types: `ReactTool` / `ReactAction` / `ReactTrace` / `ReactLoopResult`

### `react-stream.ts` — streamed ReAct loop
- `runReActLoopStream(params)` — loops up to `maxSteps` (default 4): each step calls the chat stream, forwards deltas live, tool steps emit `thought` + `rollback` (thought text rolled out of the final doc) + `tool` (paced), and call `onTrace` per step for live trace persistence; final step (no tool calls) → `result` with content/usage/trace. Steps exhausted / empty response → `react-loop`; broken stream → `network`. The `signal?` param is forwarded to every upstream call and, when already aborted at the start of a round, returns `network` immediately (saves tokens on disconnect); the tool step's assistant history message carries the thought text as `content` (the model continues from it; an empty string still falls back to `null` for provider compatibility)

### `orchestrator.ts` — generic supervisor+specialist orchestration (domain-agnostic)
- `runSupervisedStream({model, ctx, supervisor, specialists, onTrace?, signal?})` — AsyncGenerator yielding `OrchestratorStreamEvent`: the supervisor runs one ReAct loop; each specialist is wrapped as a `delegate_<agentId>` tool injected into the supervisor's tool list; calling a delegate runs the specialist's full task, and the observation is the specialist's final content; `signal` is forwarded to both the supervisor's and each specialist's loop (cancels in-flight delegations on disconnect)
- Types: `SpecialistAgent` (agentId/tool & prompt builders + maxSteps/timeoutMs), `SupervisorConfig` (buildTools receives the delegate tools and may append its own), `OrchestratorStreamEvent` (`agent_start` / `agent_end` / `delta` / `thought` / `rollback` / `tool` / `result`; the first five carry an agentId), `OrchestratorResult` (ok: content/usage/trace, each trace step tagged with `agent_id`)
- Implementation: a channel pump decouples the supervisor task from the generator's consumption (no lost events / deadlock); only the supervisor's delta/rollback are emitted outward, specialist deltas/rollbacks are dropped (they surface as delegate observations); usage is aggregated across agents via `mergeUsage`; the trace is flattened in global event order; disconnect converges via `channel.end()` without hanging

### `ssrf.ts` — SSRF protection (pure functions)
- `isAllowedBaseUrl(url)` — https only + host not in private/reserved ranges
- `isPrivateHost(host)` — IPv4/IPv6 literal checks (incl. embedded-IPv4 mapping, 6to4, ULA, link-local…), `.local` / `.internal` reserved TLDs
- `hostResolvesToPublic(host)` — every resolved A/AAAA must be public, blocking "public domain resolving to an internal address"

### `dns.ts` — DNS isolation
- `resolveHostAll(host)` — thin wrapper over `node:dns/promises.lookup({all:true})`; tests can `vi.mock("./dns")`

---

## 3. `lib/forecast-agent/` — Deterministic ensemble + AI interpretation

"Numbers first, prose second": `engine/` is a pure-function math kernel (reproducible, unit-tested); `agent/` holds the prompt and tool registry, with the ReAct loop and chat primitives provided by `lib/agent-core/`; `stream/` orchestrates the streaming; `db/` holds persistence primitives. All weather numbers come from the kernel; AI only translates metrics into natural language, so it cannot fabricate values.

### `stream/stream.ts` — streaming orchestration (the only generation entry)
- `runForecastAgentStream(session, service, params)` — AsyncGenerator yielding `ForecastAgentStreamEvent`:
  reads existing → success/pending yields `duplicate`; failed goes through the 5-min cooldown check then retries; `claimPending` claims the unique key city×day×locale → `predict` ensemble → `runSupervisedStream` multi-agent orchestration → `validateMarkdownDoc` light validation → `settleRow` persist.
  Event types: `status` (phase) / `delta` / `thought` / `rollback` / `tool` (all carrying `agentId`; only the supervisor's deltas reach the frontend) / `agent_start` / `agent_end` (boundaries) / `duplicate` / `done` / `error`.
  Failures during generation persist as failed + `failed_at`; disconnect cleanup via finally deletes still-pending rows.

### `agent/tools.ts` — ReAct tool registry
- `buildTools({result, locale})` — a single read-only tool:
  - `query_source(source)` — read back one source's raw forecast snapshot (for divergence verification; `get_metric` was removed — the metric table is inlined in the prompt, so re-querying it is pure duplication)
  - JSON-schema params mirror the zod validators inside `execute`; tool descriptions follow the locale

### `agent/specialists.ts` — forecast-generation specialist roster
- Type `ForecastAgentCtx` (city / date / deterministic result / locale) — shared by all agents' prompt and tool builders
- Agent id constants: `SUPERVISOR_AGENT_ID` / `RECONCILE_AGENT_ID` / `RISK_AGENT_ID`
- `buildReconcileSpecialist(ctx)` — source cross-check: reuses `buildTools` (query_source), maxSteps=3
- `buildRiskSpecialist(ctx)` — risk review: no tools, maxSteps=1
- `buildSupervisorConfig(ctx)` — supervisor: buildTools passes delegate tools through unchanged, maxSteps=4
- `toolDescription` follows the locale (delegate tool docs must be English in en mode)

### `agent/prompt.ts` — AI prompt assembly (split per agent)
- Type `ForecastAgentCtx` — shared agent context (see specialists.ts)
- `buildSupervisorMessages(ctx)` — supervisor: the task layer hard-requires calling `delegate_reconcile` / `delegate_risk` before finalizing (deterministic delegation); the output contract is exactly `## Reasoning` + `## Forecast`
- `buildReconcileMessages(ctx)` — source cross-check: read-only constraint + divergence block forcing `query_source` per diverging source; outputs a conclusion for the supervisor to cite
- `buildRiskMessages(ctx)` — risk review: interprets only risk_flags, never fabricates; no tools
- `formatMetricValue(locale, result, metricId)` — single formatting source for metric values (used to assemble the prompt's metric table)
- `buildContext` / `divergenceBlock` — exported for reuse in each agent's user data section
- Constant `METRIC_ROW_IDS` — single source of metric-table row order

### `agent/prompt-text.ts` — prompt localization table
- Constant `TEXTS` — zh/en copy (metric-line templates, condition/level/confidence labels, risk lines, divergence templates); `{key}` placeholders filled by prompt.ts
- Types `LocaleText` / `MetricMeta` / `AgentRoleText`; `LocaleText.agentRoles` — five-layer system text for supervisor/reconcile/risk; `supervisorUserOutput` — the supervisor user message's two-section output contract

### `engine/ensemble.ts` — deterministic ensemble engine (pure functions)
- `predict(inputs, weights)` — main entry: weighted means (high/low/precip/wind/humidity) → poP → condition vote → Beaufort scale → prediction interval → confidence → risk flags → full `PredictionResult`
- Sub-functions: `weightedMean` / `weightedStd` / `precipitationProbability` / `precipLevel` / `conditionVote` / `beaufort` / `predictionInterval` / `confidence` / `riskFlags`
- Constants `FORMULA_VERSION` (persisted per row), `RAIN_THRESHOLD_MM`, `RISK_THRESHOLDS`

### `engine/weights.ts` — dynamic source-weight calibration
- `computeWeights(supabase)` — daily recompute entry: parallel consistency score + truth MAE → three-layer blend
- Pure functions: `scoreConsistency` (avg absolute deviation from the other two sources' median), `computeMae` (vs `weather_truth`), `blendWeights` / `blendParams` (α/β/γ transition by truth-day count), `median`
- Constants `PRIOR` (prior weights), `SOURCES`; type `Weights` (Record + `detail`)

### `engine/divergence.ts` — cross-source divergence detection (pure functions)
- `detectSourceDivergences(inputs)` — precipitation divergence (wet/dry groups) → condition divergence (>1 group) → temperature divergence (spread ≥ 3°C); feeds the prompt's mandatory-verification block

### `engine/truth.ts` — reference truth collection
- `backfillTruth(supabase)` — per city, per source fetches the last 2 days and keeps "yesterday", upserts the three-source median into `weather_truth`; then prunes rows older than 31 days
- Internal `pruneOldTruth` — keeps the truth table bounded (Tokyo-day cutoff)

### `db/db.ts` — ForecastAgent persistence primitives
- `readForecast(supabase, cityId, day, locale)` — read the existing row by city×day×locale
- `readForecastForCity(supabase, cityId, locale)` — read-only entry; local day computed in the city's timezone (shared by polling)
- `claimPending(service, cityId, day, locale, email)` — insert to claim pending; 23505 conflict reads back the existing row, failed rows reset to pending for retry
- `settleRow(service, rowId, patch)` — write the terminal state (success with all metrics / failed fallback)
- `clearPredictions(service)` — truncate the predictions table (daily cron)
- `buildSourceInputs(supabase, cityId, day)` — assemble per-source inputs for the day (daily rows primary + current for humidity/wind)
- `isWithinRetryCooldown(failedAt, now)` — 5-minute failure-cooldown check; constant `RETRY_COOLDOWN_MS`

### `common/errors.ts` — ForecastAgent error codes
- Type `ForecastAgentErrorCode`: `no-model` / `retry-cooldown` / `insufficient-data` / `provider` / `parse` / `consistency` / `react-loop` / `generic`. Shared by orchestration and the frontend hook/views so UI never depends on the orchestration module.
- `FORECAST_ERROR_CODES` (set) + `isForecastErrorCode(code)` — known-code guard (UI filters illegal codes before i18n lookup, defending against external `error_code` drift)

---

## 4. `lib/schemas/` — Zod trust-boundary schemas (shared client/server)

Per `.claude/rules/zod-usage.md`: validate only untrusted input, derive types via `z.infer`, define once and share.

### `weather.ts` — weather canonical schema
- `sourceSchema` / `conditionCategorySchema` — source enum / normalized category enum
- `cityPointSchema` / `weatherPointSchema` / `forecastItemSchema` / `normalizedWeatherSchema` — city input, weather point, forecast item, normalized single-source result; types `CityPoint` / `WeatherPoint` / `ForecastItem` / `NormalizedWeather`
- Conventions: times are UTC ISO; conditionCode/Label keep the source value; cross-source comparison uses only `conditionCategory`

### `forecast-agent.ts` — ForecastAgent trust-boundary schemas
- Constant `METRICS` (metric ids — single source for AI references and tool validation) and `isMetricId`
- Types `SourceInput` / `PredictionResult` / `RiskFlag` (kernel output, trusted internal)
- `reactTraceSchema` etc. — ReAct trace (cards safeParse the jsonb on read); steps carry optional `agent_id` (which agent produced the step after multi-agent orchestration; legacy rows are null and the frontend falls back to a single-group timeline)
- `ForecastDbRow` — prediction row snake_case type (migrations 0006–0012)
- `REASONING_HEADINGS` / `FORECAST_HEADINGS` / `splitMarkdownDoc` — Markdown two-section split
- `validateMarkdownDoc(md, result, opts?)` — light validation: both sections present + high/low and poP within tolerance of the ensemble + anti-hallucination clamps on temperatures/percentages
- Generic AI wire schemas (`chatResponseSchema` / `chatUsageSchema`) moved to `agent-core.ts`

### `agent-core.ts` — generic AI wire schemas (OpenAI-compatible chat response)
- `chatUsageSchema` / `ChatUsage` — usage billing fields (prompt/completion/total); optional as a block since some providers omit it
- `chatResponseSchema` — choices[].message (content + optional tool_calls) + optional usage; external AI response, validated at runtime

### `ai.ts` — AI model config schemas
- `connectionSchema` — valid URL + non-empty API Key (for "test connection")
- `modelConfigSchema` — connection + required model (for save)
- `modelsResponseSchema` — OpenAI-compatible `/models` response

### `ai-agent.ts` — AI assistant chat schemas
- `conversationMessageSchema` / `conversationMessagesSchema` — message object / array (role user|assistant + content + created_at + optional `usage` reusing `chatUsageSchema` + optional `a2ui` reusing `a2uiMessageSchema`, the server-templated card message series persisted as jsonb); type `ConversationMessage`
- `chatRequestBodySchema` — chat request body: conversationId uuid + non-empty content + locale zh/en + model reuses `modelConfigSchema`
- `deleteConversationSchema` — valid uuid only; type `ConversationRow` (id/title/updated_at)
- messages jsonb read back from DB is safeParse-fallbacked at the boundary

### `a2ui.ts` — a2ui card message schemas (shared by chat-card persistence)
- Constant `BASIC_CATALOG_ID` — the catalogId string of @a2ui/react's basicCatalog (referenced server-side without importing React)
- `a2uiComponentSchema` / `a2uiMessageSchema` — v0.9 message envelopes (createSurface/updateComponents/updateDataModel/deleteSurface) and component structure validation; types `A2uiComponent`/`A2uiMessage`
- `a2uiMessagesSchema` — message array (DB read-back jsonb safeParse-fallbacked at the boundary, paired with `conversationMessageSchema.a2ui`)
- The catalog component schemas (MetricTile) live in `a2ui-catalog.ts`: web_core's runtime pins zod ^3.25.76, so the component schema must be built with the same zod (v3, imported via the npm alias `zod-v3`), hence kept in a separate file from the v4-zod message envelopes

### `a2ui-catalog.ts` — a2ui catalog component schemas (strictly validated by the client renderer)
- `metricTileSchema` — the MetricTile forecast-metric tile component schema (zod v3, same source as web_core's runtime; icon/chip semantic keys + static label + value/sub reusing web_core's exported `DynamicStringSchema`: `{path}` binding / `{call}` function call / literal; `.strict()` rejects unknown fields); server templates (forecast-card.ts) must emit tile messages that match it; type `MetricTileProps`
- v3 is required because GenericBinder recognizes dynamic strings via `_def.typeName` (removed in zod v4) and error formatting reads `error.errors` (v4 only has issues)

### `auth.ts` — auth schemas
- `loginSchema` / `registerSchema` (two-step: password+confirm on step 1, OTP on step 2) / `verifySchema` / `forgotSchema` / `verifyResetSchema`
- Error messages are `auth.errors.*` i18n keys; zod v4 `.check()` handles password-confirm consistency

### `city.ts` — city form schemas
- `createCitySchema` — required names, string lat/lon validation (avoids empty string → 0°) + range, required timezone
- `deleteCitySchema` — valid uuid only

### `pagination.ts` — pagination query-param schema (shared FE/BE)
- `paginationParamsSchema` — normalizes `?page=`: string→number coercion, page≥1, defaults when absent (page size is fixed at 20 per page, not URL-driven)
- `parsePagination(params)` — returns the normalized result on safeParse success, otherwise falls back to `{ page: 1 }`
- Constant `DEFAULT_PAGE_SIZE` (20); `totalPages(total, pageSize)` — at least 1 page
- Pure, shared FE/BE (no server dependency); the pagination bar and `totalPages` also use it

---

## 5. `lib/` misc

### `model-config.ts` — AI model config storage (client, per-email)
- `getModelConfig(email)` / `saveModelConfig(email, config)` / `clearModelConfig(email)` — localStorage read/write with SSR guards and JSON/schema fallback; snapshot cache for `useSyncExternalStore`
- `configKey(email)` — storage key (lowercased email)
- `subscribeModelConfig(listener)` — listener set, emits on changes
- `buildModelsUrl(baseUrl)` — build the `/models` URL (trailing slash + dedupe)
- `loadModels(baseUrl, apiKey)` — call the OpenAI-compatible `/models` endpoint (via `fetchJson`), return model ids
- Error class `ModelConfigError`

### `utils.ts` — shared utilities
- `cn(...inputs)` — clsx + tailwind-merge className merge
- `formatWeatherNumber(value)` — unified weather-number display: one decimal by default; tiny non-zero values that would round to `0.0` keep two decimals

### `ai-agent/` — AI assistant chat module

Main-agent chat module, split like forecast-agent: `agent/` holds the main agent's prompt and tool registry, `common/` holds the cross-route error codes / event contract / SSE helpers, `db/` holds the conversation CRUD Server Actions (persistence primitives).

### `ai-agent/agent/prompt.ts` — main-agent prompt (context + delegation strategy)
- `buildMainAgentSystemPrompt(locale, today)` — per-locale system prompt: identity (WeatherMind's weather main agent), today's reference date (JST), platform background (3-source data + last-7-days historical snapshots + multi-source deterministic ensemble), intent routing (general chat / today's weather not asking for the authoritative forecast → default to query_sources for all 3 sources / historical weather → query_weather_history / today's forecast → query_forecast, generate_forecast when no data / beyond coverage stated honestly), hard rules (numbers must come from tools, language follows the user, **forecast de-duplication: when the authoritative forecast is returned the a2ui icon card shows the key metrics automatically, so the text stays a concise narrative and must NOT restate the metrics as a table**). Tool definitions come from the request's tools field; the prompt only gives strategy and flow, not tool descriptions (saves tokens)
- `buildMainAgentMessages(history, locale, today)` — stored history → wire ChatMessage (system prepended; tool process is not persisted, so history holds only user/assistant)

### `ai-agent/agent/tools.ts` — main-agent tool registry
- `buildMainAgentTools({session, service, email, model, locale, signal})` — five tools (zod arg validation mirrors the JSON-schema sent to the API; `signal` is forwarded to the delegated sub-agent so it stops burning tokens when the main agent's client disconnects):
  - `query_city(keyword)` — ILIKE search on cities by Japanese/English name (escapes `%`/`_`/`\`/`,` — the comma is the PostgREST `.or()` separator, so without escaping "Tokyo, Japan" would be split into multiple conditions and fail), is_active filter, limit 5
  - `query_sources(cityId)` — resolves the city to compute today's local day (`toLocalDateKey`), then reads the per-source snapshot from `weather_daily` (high/low, precipitation, condition), mapped per source with a display label; no-data when absent / error on query failure (DB failure on the city lookup is distinguished from "city not found")
  - `query_weather_history(cityId, days?)` — reads the last `days` (default 7; capped at 7 to match the platform retention window, out-of-range rejected by the schema) of per-source daily snapshots from `weather_daily`, grouped by local day (per-source within a day, with display label); no-data when absent / error on query failure
  - `query_forecast(cityId)` — `readForecastForCity` reads today's forecast: no-data when absent / error+error_code when failed / metrics observation on success
  - `generate_forecast(cityId)` — **asynchronously delegates to the sub-agent**: consumes `runForecastAgentStream`, done/duplicate → metrics observation, error passes through the sub-agent's code; rejects without an email (claim needs created_by)

### `ai-agent/common/errors.ts` — constrained error codes for conversation actions (client-shared, mirrors weather/errors)
- `ConversationActionErrorCode` — `unauthorized`/`invalidInput`/`notFound`/`generic`
- `ConversationActionError` — error class thrown by client mutationFn, `code` drives i18n copy; Server Actions return result objects (never throw), error-code mapping is centralized here

### `ai-agent/common/chat-events.ts` — chat SSE event types (types only)
- `ChatSseEvent` — `{type:"delta",text}` / `{type:"rollback",chars}` (tool-step thought text rolled back; it is not part of the final answer) / `{type:"a2ui",messages}` (the server-templated card message series, arrives before done) / `{type:"done",content,usage}` (usage is the request's cross-step accumulated token usage, null when absent) / `{type:"error",code}` (code is `ProviderErrorCode` or "generic"); shared by the chat route and the client hook

### `ai-agent/common/route-helpers.ts` — shared tools for /api/ai-agent streaming routes
- `requireUser()` — self-auth (`createClient` + `getUser`; returns a 401 Response when unauthenticated), returns the session alongside for RLS queries / param passing
- `readJsonBody(request)` — parse the JSON body, failing as 400 "no-model"
- `createSseResponse(run)` — SSE response construction (manual `ReadableStream` start mode per-event encoding, outer catch falls back to an in-band `error` event, finally closes); returns a Response with `SSE_RESPONSE_HEADERS`
- Constant `SSE_RESPONSE_HEADERS` — the 4 SSE response headers

### `ai-agent/db/conversation-actions.ts` — conversation create/delete Server Actions ("use server")
- `createConversationAction()` — `getUser` for user.id (absent → unauthorized) → service client creates a conversation and returns the id
- `deleteConversationAction({id})` — schema first (failure → invalidInput) → `getUser` → delete by id + user_id; 0 rows → notFound
- Both return result objects (never throw); error codes `unauthorized`/`invalidInput`/`notFound`/`generic`; message persistence is the chat route's job, actions don't touch messages

### `ai-agent/a2ui/forecast-card.ts` — weather-result card templating (pure functions, server)
- `buildForecastCardMessages(input, locale): A2uiMessage[]` — templates the main agent's authoritative tool observation (`ForecastCardMetrics`, same shape as tools.ts's observation) into three a2ui v0.9 messages (createSurface → updateComponents → updateDataModel): a root Column (no Card, so the host's green gradient shows through) → title Text + rows of two `MetricTile`s each (icon/chip semantic keys + static label + value/sub bound to `{path:"/key"}` and `{path:"/keyInterval"}`); every id a container references in `children` must exist in the component table, otherwise the renderer falls back to a `[Loading row-...]` placeholder; fixed tile order (high/low with interval captions → precip probability/level → condition → wind → humidity → confidence → risk), last row single; null values skip their tile, risk flags join each "type (level)"; numbers round for display, copy reuses forecast-agent's `TEXTS` localization table (consistent with the forecast body); missing city name falls back to a "today's forecast" title. The model generates no UI and transcribes no numbers — the card only reads back the tool observation

### `ai-agent/a2ui/capture.ts` — tool-observation accumulator (pure functions, called incrementally in the route)
- `createForecastCardAccumulator()` — accumulator initial state (cityNames/forecast/cityId)
- `reduceToolEvent(acc, ev, locale)` — extracts from `tool` events: query_city records id→display name (locale picks name_ja/name_en, preferred field falls back to the other language); query_forecast/generate_forecast record the latest metrics/cityId when `status==="success"` (later wins); no-data/error/pending and other tools are ignored
- `toForecastCardInput(acc)` — converts the accumulated state to `{cityName, metrics}`, returns null when there is no successful forecast (caller sends no card)

---

## 6. `supabase/` — Supabase clients and auth

### `server.ts` — server session client
- `createClient()` — `createServerClient` (@supabase/ssr), auth cookies synced both ways with the request; for Server Actions / Route Handlers; swallow cookie-write errors during SSR rendering (the proxy refreshes them centrally)

### `service.ts` — service_role trusted-write client
- `createServiceClient()` — bypasses RLS; only for pipeline writes and city create/delete; **never import in client components** (would leak the service_role key)

### `proxy.ts` — session-refresh middleware
- `updateSession(request, supabaseResponse)` — sync/refresh auth cookies on the response already produced by intl (must reuse the passed response — rebuilding loses the rewrite); returns `{response, user}` for the root proxy's route guard

### `auth/actions.ts` — auth Server Actions ("use server")
- `loginAction(values)` — sign in and establish the session
- `registerSendCodeAction(values, opts?)` — register step 1: `is_email_registered` preflight (optional) → signUp to send the OTP
- `registerVerifyCodeAction(values)` — register step 2: verifyOtp(type:"signup")
- `forgotSendCodeAction(values)` — forgot-password step 1: probe "new password equals old" by attempting sign-in → resetPasswordForEmail to send the code
- `forgotVerifyCodeAction(values)` — step 2: verifyOtp(type:"recovery") → updateUser with the new password → re-sign-in fallback
- `logoutAction()` — sign out
- All return `AuthResult` result objects (never throw); errors map via `mapAuthError` to limited codes

### `auth/errors.ts` — auth error mapping
- `mapAuthError(err)` — Supabase error → limited `AuthErrorCode` (network / rate-limit / OTP / user-exists, etc.)
- Class `AuthError` — thrown by client mutations, carries `code` for i18n lookup

---

## 7. `app/[locale]/` — Pages

### `layout.tsx` — root layout
`generateStaticParams` (zh/en static routes), `generateMetadata`; wraps children in `NextIntlClientProvider` (messages) + `QueryProvider` + `TooltipProvider` + `ToastProvider`.

### `page.tsx` — landing page
`Navbar` + `Body` + `Footer` stacked vertically (the unauthenticated entry).

### `login/page.tsx` / `register/page.tsx` / `forgot-password/page.tsx`
`AuthCard` shell wrapping the corresponding form component.

### `dashboard/layout.tsx` — dashboard layout
Server reads the session email, redirects unauthenticated users; `Sidenav` (admin flag toggles the logs entry) + `DashboardNavbar` + content area.

### `dashboard/loading.tsx` — skeleton loading for sub-routes
### `dashboard/page.tsx` — home overview (post-login redirect target)
Reads the session to determine the admin flag → `DashboardHomeView` (welcome banner + feature entry cards; the logs card is admin-only).
### `dashboard/ai-agent/page.tsx` — AI assistant chat page
Server-fetches the conversation list (ordered by `updated_at` desc) + the current conversation's initial messages (messages jsonb safeParse fallback); `?id=` resolution mirrors `resolve-city` (missing/invalid redirects to the canonical URL); the unconfigured-model gate happens client-side (see AiAgentView).
### `dashboard/ai-agent/setup/page.tsx` — unconfigured-model hint page
Client-redirected here from AiAgentView; copy + `SetupGuide` "go to settings" button.
### `dashboard/cities/page.tsx` — server-fetches cities by `?page=` (fixed page size of 20) + admin flag → `CitiesView`; redirects to the last page when out of range
### `dashboard/history/page.tsx` — resolves `?city=` → loads last-7-days `weather_daily` → `HistoryView` (full fetch server-side; the table slices pages client-side)
### `dashboard/logs/page.tsx` — admin-guarded; fetches `weather_runs` by `?page=` (fixed page size of 20) → `LogsView` (card fills the remaining height with an inner scroll so the pagination bar stays pinned at the bottom); redirects to the last page when out of range
### `dashboard/settings/page.tsx` — renders `ModelConfigCard` (with the user email)
### `dashboard/forecast/page.tsx` — forecast page
Resolves `?city=` to one city → fetches that city's three-source `weather_current` + latest `weather_runs` → `ForecastView`.

---

## 8. `app/api/` — Route Handlers (/api bypasses the proxy; self-authenticate)

### `api/ai-agent/forecast/route.ts` — forecast streaming endpoint
- `POST(request)` — auth via the shared `requireUser` (401 when unauthenticated); the model config in the body is untrusted input, re-validated server-side with `modelConfigSchema`; errors before the stream starts return non-2xx JSON, errors after stream start go through in-band `error` events (SSE)
- Streaming via the shared `createSseResponse` (manual `ReadableStream` start mode per-event encoding + disconnect fallback); forwards `request.signal` for client disconnects; Next 16 note: no `runtime="edge"` (node:dns needs the Node runtime)

### `api/ai-agent/chat/route.ts` — main-agent chat streaming endpoint
- `POST(request)` — auth via the shared `requireUser` (401 unauthenticated); body validated with `chatRequestBodySchema` (400 on failure); conversation ownership check (RLS fallback, 404 `conversation-not-found`); **persists the user message via the atomic-append RPC `append_conversation_message`** (a single UPDATE appends at the row level, guarding against lost messages under concurrent tabs; returns the authoritative messages array), then runs the main-agent ReAct loop (`runReActLoopStream`, maxSteps 6, per-step 300s timeout): messages via `buildMainAgentMessages` (includes today's reference date), tools via `buildMainAgentTools` (query city / read forecast / delegate generation to the sub-agent); the consume loop accumulates tool observations via `reduceToolEvent` (city names + forecast metrics); streaming via `createSseResponse`, only delta/rollback/done/error are forwarded (**final answer only** — the tool steps' thought/tool events are consumed, thought text is rolled back; **when a successful forecast was accumulated it emits a `{type:"a2ui"}` card message before done**); **the assistant reply is persisted in the `result` branch (same RPC, with usage and a2ui) before `done` is sent** — by the time `done` arrives a refreshed client always reads the full reply, and a persist failure sends `error` rather than claiming success; done forwards `result.usage`; **`request.signal` is forwarded** — a client disconnect aborts the in-flight LLM call to save tokens, and the reply is not persisted (only the user message remains)

---

## 9. `components/` — UI components

### `components/auth/`
- `login-form.tsx` — login form: TanStack Form validation → `loginAction` mutation → success toast + redirect
- `register-form.tsx` — two-step register (step 1 sends the code with a `checkExists` preflight, step 2 verifies), drives `registerSendCodeAction` / `registerVerifyCodeAction`
- `forgot-form.tsx` — two-step forgot-password form (new password stashed client-side, persisted after code verification)

### `components/auth/presets/`
- `auth-card.tsx` — auth page shell (back-to-landing + language toggle + grid background + frosted-glass card)
- `auth-field.tsx` — label + input + inline-error container
- `email-field.tsx` — email input preset (fixed placeholder/autofill semantics; locks the email during the verify step)
- `field-error.tsx` — renders schema issue messages (message = i18n key)

### `components/dashboard/forecast/`
- `forecast-view.tsx` — forecast page view: city select (navigates to a new `?city=`), admin manual refresh, latest run status, left city card + right reasoning card (equal height), "Generate" button (enabled when a model is configured) → streamed rendering via `useForecastStream`
- `forecast-agent-card.tsx` — ForecastAgent result card: streamed Markdown rendering, metrics grid + Markdown (new rows) / legacy structured fallback, guarded error codes
- `forecast-metrics-grid.tsx` — 9 metric icon cards (high/low/poP/precip level/condition/wind/humidity/confidence/risk); values from authoritative DB fields
- `forecast-reasoning-card.tsx` — multi-agent timeline card: groups trace steps by `agent_id` (group headers use the localized `agentLabel`, unknown ids fall back to the raw id; legacy rows with no agent marker become a single group without a header), rendered streaming or from `react_trace`; auto-scrolls to the newest step

### `components/dashboard/ai-agent/`
- `ai-agent-view.tsx` — chat page main view ("use client"): conversation sidebar + chat area; `useHydrated` checks modelConfig after mount (null on SSR), null → `router.replace("/dashboard/ai-agent/setup")` (no first-paint misredirect); chat area is keyed by conversationId, switching remounts it
- `conversation-list.tsx` — sidebar: "New chat" button + conversation list (active highlight, hover delete icon, confirm Dialog); drives `createConversationAction` / `deleteConversationAction`, then `router.refresh()` + navigation; fallback title when empty
- `chat-panel.tsx` — chat panel: message list (auto-scroll) + input area (Enter sends / Shift+Enter newline, disabled when trimmed-empty or streaming); `useChatStream` streamed rendering, appends assistant on done (with usage and the a2ui card message series) + refresh; errors mapped to i18n copy + partial reply greyed out
- `message-bubble.tsx` — message bubbles: user right-aligned primary bubble, assistant left-aligned `<Markdown>` card; streaming indicator dots; assistant messages with `usage` render a token-usage footer below (mirrors the forecast card); messages with `a2ui` (the server-templated card message series) render `<A2uiCard>` below the markdown
- `a2ui-card.tsx` — renders a server-issued a2ui card ("use client"): one independent `MessageProcessor([aiAgentCatalog])` (basicCatalog + custom MetricTile, below) per card, subscribes to surface create/delete to sync the list, renders `<A2uiSurface>` natively; `injectStyles` injects structural styles idempotently (skipped during SSR); `processMessages` is guarded by a message-reference change so StrictMode's double mount can't reprocess the same createSurface, and a failure degrades the whole card to an empty render without blocking the chat. The outer shell borrows the forecast-agent result card's visual language (ForecastCardShell success tone): green-gradient container + top color bar + rounded border and shadow; legacy Card-rooted messages from the DB carry an opaque background/border, neutralized via the `--a2ui-card-*` CSS variables so the gradient shows through
- `a2ui-catalog.tsx` — ai-agent custom a2ui catalog ("use client"): appends the `MetricTile` component (createComponentImplementation + `metricTileSchema`) to basicCatalog; MetricTile maps the server-issued icon/chip semantic keys to lucide icons + colored icon chips, matching the forecast page's ForecastMetricsGrid conventions (ICONS and CHIPS lookup tables, unknown keys fall back)
- `setup-guide.tsx` — hint-page "go to settings" button (localStorage subscription auto-refreshes after saving config)

### `components/dashboard/cities/`
- `cities-view.tsx` — read-only city table + admin add entry + inline delete (confirm dialog, hard delete cascade)
- `city-add-dialog.tsx` — create-city dialog (drives `createCityAction`, field-level i18n errors)

### `components/dashboard/history/`
- `history-view.tsx` — history view: city selector + admin refresh/backfill + charts + daily table (client-side slice pagination, 20 per page)
- `history-charts.tsx` — 4 KPI tiles + temperature-trend line (3 sources × high/low + cross-source band) + daily precipitation bars + weather-distribution cards

### `components/dashboard/`
- `logs/logs-view.tsx` — read-only `weather_runs` table (status pill, trigger, cell counts, JST times)
- `navbar.tsx` — top bar: breadcrumb + language toggle + email + logout
- `sidenav.tsx` — fixed sidebar: brand + icon nav (logs admin-only; no-href items render disabled)
- `logout-button.tsx` — logout: `logoutAction` + clear per-user model config + toast + redirect
- `home/dashboard-home-view.tsx` — home overview (server component): gradient welcome banner (today's date, Tokyo timezone) + feature entry card grid; color accents map to each page's theme, logs card admin-only
- `settings/model-config-card.tsx` — model-config card: `loadModels` test connection → pick model → cache per-email to localStorage; clear button

### `components/notlogin/`
- `body.tsx` — landing hero + two feature cards + login/GitHub buttons
- `navbar.tsx` — landing top nav (brand + language toggle + login/register)
- `footer.tsx` — single-line brand footer

### `components/providers/`
- `query-provider.tsx` — root TanStack Query provider; mutation retry disabled (prevents duplicate submits)

### `components/ui-preset/` — brand presets
- `button.tsx` — `ButtonBlue` / `ButtonGreen` brand buttons
- `data-table.tsx` — generic read-only table (blue accent bar, empty state, optional sticky-header scroll); exports `DataTable` / `DataTableRow`; optional `pagination` prop renders the pagination bar below the table (hidden on a single page); in `scrollable` mode it fills the parent's height with an inner scroll and the pagination bar pinned at the bottom
- `table-pagination.tsx` — generic pagination bar (`TablePagination`): total count · fixed page size of 20 (no switching), prev / page indicator / next; data-source-agnostic — cities/logs inject URL-navigation callbacks, history injects client-side slice callbacks
- `forecast-card-shell.tsx` — shared shell for the forecast/reasoning cards (tone gradient + top bar + status dot + phase + scroll passthrough)
- `grid-background.tsx` — light paper-grid background
- `language-toggle.tsx` — zh/en capsule switcher
- `liquid-glass-card.tsx` — frosted-glass card
- `markdown.tsx` — react-markdown + GFM rendering, elements mapped to shadcn-style classes
- `toast.tsx` — `ToastProvider` + `useToast()` (success/error/info)
- `weather-city-card.tsx` — per-city three-source current-weather card; also exports shared `WEATHER_SOURCES` / `SOURCE_COLORS`

### `components/ui/` — shadcn primitives
`breadcrumb` / `button` / `card` / `chart` / `dialog` / `input` / `label` / `select` / `skeleton` / `table` / `textarea` / `tooltip` — thin presentational wrappers over `@base-ui/react` (use variants/className; don't modify the source).

---

## 10. `hooks/` — React hooks

### `use-sse-stream.ts`
- `useSseStream({url, model, buildBody, onTransportError, onNoBodyError, onParseError, decodeError, onEvent, onReset, onError})` — shared SSE transport hook: POST + `getReader` chunk reads + `lib/weather/sse` parsing, dispatching each event to `onEvent` (ctx provides `markDone` / `fail`); owns the state machine (idle/streaming/done/error) + AbortController + network fallback + error-code mapping; returns `{status, errorCode, start(params), cancel, reset}`. Duplicate `start` while a request is in flight is ignored (guards against rapid double-send), and a new `start` first clears the previous run's accumulated content via `onReset` (prevents stale text bleeding into a retry / later turns). When the stream closes normally without a terminal event (server-side abnormal disconnect / proxy cutoff) it falls back to `onTransportError` instead of hanging in `streaming`. Shared by `useForecastStream` / `useChatStream`
- This is the sanctioned exception to "no bare fetch in the client" (TanStack Query can't carry true streaming)

### `use-forecast-stream.ts`
- `useForecastStream({cityId, locale, model, onDone, onError})` — forecast streaming hook (thin wrapper over `useSseStream`; event→content dispatch only): `delta` appends markdown, `agent_start` opens a timeline group, `thought`/`tool` join the owning agent's group, `rollback` trims thought text, `duplicate`/`done` finalize the re-read row and regroup by `react_trace`; returns `{state, start, cancel, reset}`
- `state.status`: idle/streaming/done/error
- `groupByAgent(trace)` — groups by adjacent `agent_id` preserving order (legacy rows go into a single `agentId:""` group); `state.agents` — `TimelineGroup[]`, shared by the hook and the reasoning card

### `use-chat-stream.ts`
- `useChatStream({model, locale, onA2ui, onDone, onError})` — chat streaming hook (thin wrapper over `useSseStream`): `delta` accumulates assistantText, `rollback` trims tool-step thought text from the tail, `a2ui` stashes the card message series (`state.a2uiMessages` drives the streaming bubble; `onDone(content, usage, a2ui)` returns it too), `done` finalizes (carries this request's token usage, driving the bubble footer), `error` carries the code; returns `{state, start({conversationId, content}), cancel, reset}`; non-2xx `error` field mapped to limited codes (`conversation-not-found` → `conversationNotFound`); does not hold the message list (parent owns it)

### `use-model-config.ts`
- `useModelConfig(email)` — `useSyncExternalStore` over the local model config; null on SSR, reads localStorage after mount, auto-refreshes on save/clear

### `use-element-height.ts`
- `useElementHeight()` — ResizeObserver tracks the element's live height, returns `{ref, height}`; `useLayoutEffect` measures before first paint

### `use-paginated-navigation.ts`
- `usePaginatedNavigation(baseQuery={})` — server-side pagination navigation: `goToPage(page)` writes the query string then `router.push` (page size fixed at 20, so `pageSize` is not carried); `baseQuery` preserves existing params (e.g. the history page's `?city=`); avoids `useSearchParams` to dodge the client-component Suspense build constraint

---

## 11. `i18n/` — Internationalization

### `routing.ts`
- `routing` — `defineRouting({locales:["zh","en"], defaultLocale:"zh", localePrefix:"as-needed"})` (zh without prefix, en at /en)

### `navigation.ts`
- Exports typed `Link` / `redirect` / `usePathname` / `useRouter` / `getPathname` (locale prefixes handled automatically, never hand-build URLs)

### `request.ts`
- `getRequestConfig` — takes the locale from route params, 404 when unsupported; loads `messages/{locale}.json`

### `messages/zh.json` / `messages/en.json` — copy resources (page/form/error i18n keys)

---

## 12. `scripts/` and root files

### `scripts/weather-cron.ts` — GitHub Actions daily ingestion entry
`runWeatherPipeline("cron")` → clear predictions (`clearPredictions`) → backfill truth (`backfillTruth`); logs the full summary; exits non-zero when the whole run fails (succeeded=0) so the workflow turns red. Never throws.

### `proxy.ts` — root middleware (next-intl + Supabase)
Runs `intlMiddleware` to negotiate the locale, then `updateSession` to refresh the session; `PUBLIC_PATHS` whitelist drives the route guard (unauthenticated → `/`, authenticated → `/dashboard`). Helpers `localeOf` / `stripLocale` / `guardTarget` (exported for unit tests).

### `next.config.ts` — next-intl plugin + `experimental.rootParams`
### `vitest.config.ts` — jsdom env, setup file, `@` alias, v8 coverage scoped to `lib/` and `supabase/`
### `vitest.setup.ts` — imports jest-dom matchers
### `stryker.config.json` — mutation-testing whitelist (only mutates tested lib/supabase sources), 80% break
### `.github/workflows/ci.yml` — push/PR to main: typecheck → lint → build; separate job runs tests with coverage and uploads to Codecov (OIDC)
### `.github/workflows/stryker.yml` — PR-triggered targeted mutation on changed, tested sources
### `.github/workflows/weather-cron.yml` — daily 15:00 UTC run of `scripts/weather-cron.ts`

---

## 13. `supabase/migrations/` — DB migrations

| Migration | Purpose |
| --- | --- |
| `0001_weather.sql` | `cities` (unique `name_en`, seeds 8 Japanese cities), `weather_current` (upsert key city×source), `weather_runs` (run status/counts) |
| `0002_weather_daily.sql` | `weather_daily` (city×source×day snapshot, upsert key city×source×day) |
| `0003_rls.sql` | Enables RLS on the four tables with authenticated read-only select policies |
| `0004_remove_weather_forecast.sql` | Drops the legacy hourly `weather_forecast` table |
| `0005_email_registered.sql` | security-definer function `is_email_registered` (register preflight; service_role only) |
| `0006_forecast_agent.sql` | `forecast_agent_predictions` (unique city×day, deterministic metric columns, AI text columns, `error_code`) + `weather_truth` (observed median truth) |
| `0007_forecast_agent_locale.sql` | Adds `locale`; unique key becomes city×day×locale |
| `0008_forecast_agent_tokens.sql` | Adds `prompt_tokens` / `completion_tokens` |
| `0009_forecast_agent_react_trace.sql` | Adds `react_trace` jsonb (ReAct trace) |
| `0010_forecast_agent_markdown.sql` | Adds `markdown_body` (full AI Markdown output) |
| `0011_city_timezone_check.sql` | CHECK constraint `timezone = 'Asia/Tokyo'` on `cities` |
| `0012_forecast_agent_failed_at.sql` | Adds `failed_at` (failure-cooldown timer, replaces the removed daily quota) |
| `0013_ai_conversations.sql` | `ai_conversations` (user_id no FK, title, messages jsonb, created_at/updated_at; index user_id + updated_at desc; RLS select per user) |
| `0014_append_conversation_message.sql` | security-invoker function `append_conversation_message(p_conversation_id, p_user_id, p_message, p_title)`: a single UPDATE `messages || jsonb_build_array(p_message)` appends atomically (row-level lock prevents lost messages under concurrent tabs), sets the title from `p_title` on the first message, and `RETURNING messages` yields the authoritative array; executable by service_role only, ownership enforced via `where user_id = p_user_id` |

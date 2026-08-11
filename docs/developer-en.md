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
lib/forecast-agent/     Deterministic ensemble engine + AI interpretation (streamed ReAct)
lib/schemas/            Zod trust-boundary schemas (shared client/server)
lib/model-config.ts     AI model config (per-email localStorage)
supabase/               Supabase clients (session / trusted writes / proxy refresh) and auth actions
supabase/migrations/    DB migrations (0001–0012)
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

## 2. `lib/forecast-agent/` — Deterministic ensemble + AI interpretation

"Numbers first, prose second": `engine/` is a pure-function math kernel (reproducible, unit-tested); `agent/` is a bounded read-only ReAct loop; `stream/` orchestrates the streaming; `db/` holds persistence primitives. All weather numbers come from the kernel; AI only translates metrics into natural language, so it cannot fabricate values.

### `stream/stream.ts` — streaming orchestration (the only generation entry)
- `runForecastAgentStream(session, service, params)` — AsyncGenerator yielding `ForecastAgentStreamEvent`:
  reads existing → success/pending yields `duplicate`; failed goes through the 5-min cooldown check then retries; `claimPending` claims the unique key city×day×locale → `predict` ensemble → streamed ReAct → `validateMarkdownDoc` light validation → `settleRow` persist.
  Event types: `status` (phase) / `delta` (Markdown increment) / `thought` / `rollback` / `tool` / `duplicate` / `done` / `error`.
  Failures during generation persist as failed + `failed_at`; disconnect cleanup via finally deletes still-pending rows.

### `agent/chat.ts` — OpenAI-compatible chat shared primitives
- `assertPublicBaseUrl(baseUrl)` — SSRF preflight (literal whitelist + DNS recheck), returns error code or null
- `buildChatRequestBody(params, stream)` — wire body (`temperature:0`, optional tools, stream flag)
- `toWireMessage` / `toWireTool` — internal messages/tools → OpenAI wire shape
- `parseChatMessage(msg)` — flatten wire response to `{content, toolCalls}`
- Types: `ChatMessage` (system/user/assistant/tool), `ChatTool`, `ProviderErrorCode`

### `agent/chat-stream.ts` — streaming chat call
- `chatCompletionStream(params, opts?)` — same SSRF preflight as chat; dispatches by Content-Type: SSE stream / single-frame degrade for `application/json` / parse otherwise. Yields `ChatStreamEvent` (`delta` / `tool` / `done`)
- Internal `readSseChatStream` — reads the upstream stream block by block, accumulates tool_calls by index, takes usage from any frame; skips bad frames; cancels the reader when the consumer breaks early

### `agent/react.ts` — shared ReAct kernel
- `safeParseJson(s)` — strict JSON.parse wrapper
- `mergeUsage(a, b)` — accumulate usage across steps
- `executeToolCalls(tools, toolCalls)` — execute tool calls and build tool messages; bad calls do not abort (the error observation is fed back for self-correction)
- Types: `ReactTool` / `ReactAction` / `ReactTrace` / `ReactLoopResult`

### `agent/react-stream.ts` — streamed ReAct loop
- `runReActLoopStream(params)` — loops up to `maxSteps` (default 4): each step calls the chat stream, forwards deltas live, tool steps emit `thought` + `rollback` (thought text rolled out of the final doc) + `tool` (paced), and call `onTrace` per step for live trace persistence; final step (no tool calls) → `result` with content/usage/trace. Steps exhausted / empty response → `react-loop`; broken stream → `network`

### `agent/tools.ts` — ReAct tool registry
- `buildTools({result, locale})` — two read-only tools:
  - `query_source(source)` — read back one source's raw forecast snapshot (for divergence verification)
  - `get_metric(metricId)` — read back one platform metric's authoritative value (enum sourced from `METRICS`)
  - JSON-schema params mirror the zod validators inside `execute`; tool descriptions follow the locale

### `agent/prompt.ts` — AI prompt assembly
- `buildForecastAgentMessages(city, day, result, locale)` — system+user messages; the metric table carries only authoritative values, raw snapshots are never inlined (must call `query_source`); divergence block injects mandatory verification instructions; the whole context follows the locale
- `formatMetricValue(locale, result, metricId)` — single formatting source for metric values (shared by the prompt and `get_metric`)
- `metricMeta(locale)` — metric label/note metadata
- Constant `METRIC_ROW_IDS` — single source of metric-table row order

### `agent/prompt-text.ts` — prompt localization table
- Constant `TEXTS` — zh/en copy (metric-line templates, condition/level/confidence labels, risk lines, divergence templates); `{key}` placeholders filled by prompt.ts
- Types `LocaleText` / `MetricMeta`

### `agent/ssrf.ts` — SSRF protection (pure functions)
- `isAllowedBaseUrl(url)` — https only + host not in private/reserved ranges
- `isPrivateHost(host)` — IPv4/IPv6 literal checks (incl. embedded-IPv4 mapping, 6to4, ULA, link-local…), `.local` / `.internal` reserved TLDs
- `hostResolvesToPublic(host)` — every resolved A/AAAA must be public, blocking "public domain resolving to an internal address"

### `agent/dns.ts` — DNS isolation
- `resolveHostAll(host)` — thin wrapper over `node:dns/promises.lookup({all:true})`; tests can `vi.mock("./dns")`

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

---

## 3. `lib/schemas/` — Zod trust-boundary schemas (shared client/server)

Per `.claude/rules/zod-usage.md`: validate only untrusted input, derive types via `z.infer`, define once and share.

### `weather.ts` — weather canonical schema
- `sourceSchema` / `conditionCategorySchema` — source enum / normalized category enum
- `cityPointSchema` / `weatherPointSchema` / `forecastItemSchema` / `normalizedWeatherSchema` — city input, weather point, forecast item, normalized single-source result; types `CityPoint` / `WeatherPoint` / `ForecastItem` / `NormalizedWeather`
- Conventions: times are UTC ISO; conditionCode/Label keep the source value; cross-source comparison uses only `conditionCategory`

### `forecast-agent.ts` — ForecastAgent trust-boundary schemas
- Constant `METRICS` (metric ids — single source for AI references and tool validation) and `isMetricId`
- Types `SourceInput` / `PredictionResult` / `RiskFlag` (kernel output, trusted internal)
- `reactTraceSchema` etc. — ReAct trace (cards safeParse the jsonb on read)
- `chatResponseSchema` / `chatUsageSchema` — external AI response (untrusted, validated at runtime)
- `ForecastDbRow` — prediction row snake_case type (migrations 0006–0012)
- `REASONING_HEADINGS` / `FORECAST_HEADINGS` / `splitMarkdownDoc` — Markdown two-section split
- `validateMarkdownDoc(md, result, opts?)` — light validation: both sections present + high/low and poP within tolerance of the ensemble + anti-hallucination clamps on temperatures/percentages

### `ai.ts` — AI model config schemas
- `connectionSchema` — valid URL + non-empty API Key (for "test connection")
- `modelConfigSchema` — connection + required model (for save)
- `modelsResponseSchema` — OpenAI-compatible `/models` response

### `auth.ts` — auth schemas
- `loginSchema` / `registerSchema` (two-step: password+confirm on step 1, OTP on step 2) / `verifySchema` / `forgotSchema` / `verifyResetSchema`
- Error messages are `auth.errors.*` i18n keys; zod v4 `.check()` handles password-confirm consistency

### `city.ts` — city form schemas
- `createCitySchema` — required names, string lat/lon validation (avoids empty string → 0°) + range, required timezone
- `deleteCitySchema` — valid uuid only

---

## 4. `lib/` misc

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

---

## 5. `supabase/` — Supabase clients and auth

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

## 6. `app/[locale]/` — Pages

### `layout.tsx` — root layout
`generateStaticParams` (zh/en static routes), `generateMetadata`; wraps children in `NextIntlClientProvider` (messages) + `QueryProvider` + `TooltipProvider` + `ToastProvider`.

### `page.tsx` — landing page
`Navbar` + `Body` + `Footer` stacked vertically (the unauthenticated entry).

### `login/page.tsx` / `register/page.tsx` / `forgot-password/page.tsx`
`AuthCard` shell wrapping the corresponding form component.

### `dashboard/layout.tsx` — dashboard layout
Server reads the session email, redirects unauthenticated users; `Sidenav` (admin flag toggles the logs entry) + `DashboardNavbar` + content area.

### `dashboard/loading.tsx` — skeleton loading for sub-routes
### `dashboard/page.tsx` — placeholder home (post-login redirect target)
### `dashboard/ai-agent/page.tsx` — placeholder AI page
### `dashboard/cities/page.tsx` — server-fetches cities + admin flag → `CitiesView`
### `dashboard/history/page.tsx` — resolves `?city=` → loads last-7-days `weather_daily` → `HistoryView`
### `dashboard/logs/page.tsx` — admin-guarded; fetches latest 100 `weather_runs` → `LogsView`
### `dashboard/settings/page.tsx` — renders `ModelConfigCard` (with the user email)
### `dashboard/forecast/page.tsx` — forecast page
Resolves `?city=` to one city → fetches that city's three-source `weather_current` + latest `weather_runs` → `ForecastView`.

---

## 7. `app/api/` — Route Handlers (/api bypasses the proxy; self-authenticate)

### `api/ai-agent/forecast/route.ts` — forecast streaming endpoint
- `POST(request)` — self-auth (`createClient` + `getUser`; 401 when unauthenticated); the model config in the body is untrusted input, re-validated server-side with `modelConfigSchema`; errors before the stream starts return non-2xx JSON, errors after stream start go through in-band `error` events (SSE)
- Manual `ReadableStream` start mode encodes each event as `data: {...}\n\n`; forwards `request.signal` for client disconnects; Next 16 note: no `runtime="edge"` (node:dns needs the Node runtime)

---

## 8. `components/` — UI components

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
- `forecast-reasoning-card.tsx` — ReAct trace card (thought/action/observation), rendered streaming or from `react_trace`; auto-scrolls to the newest step

### `components/dashboard/cities/`
- `cities-view.tsx` — read-only city table + admin add entry + inline delete (confirm dialog, hard delete cascade)
- `city-add-dialog.tsx` — create-city dialog (drives `createCityAction`, field-level i18n errors)

### `components/dashboard/history/`
- `history-view.tsx` — history view: city selector + admin refresh/backfill + charts + daily table
- `history-charts.tsx` — 4 KPI tiles + temperature-trend line (3 sources × high/low + cross-source band) + daily precipitation bars + weather-distribution cards

### `components/dashboard/`
- `logs/logs-view.tsx` — read-only `weather_runs` table (status pill, trigger, cell counts, JST times)
- `navbar.tsx` — top bar: breadcrumb + language toggle + email + logout
- `sidenav.tsx` — fixed sidebar: brand + icon nav (logs admin-only; no-href items render disabled)
- `logout-button.tsx` — logout: `logoutAction` + clear per-user model config + toast + redirect
- `page-placeholder.tsx` — placeholder for under-development pages
- `settings/model-config-card.tsx` — model-config card: `loadModels` test connection → pick model → cache per-email to localStorage; clear button

### `components/notlogin/`
- `body.tsx` — landing hero + two feature cards + login/GitHub buttons
- `navbar.tsx` — landing top nav (brand + language toggle + login/register)
- `footer.tsx` — single-line brand footer

### `components/providers/`
- `query-provider.tsx` — root TanStack Query provider; mutation retry disabled (prevents duplicate submits)

### `components/ui-preset/` — brand presets
- `button.tsx` — `ButtonBlue` / `ButtonGreen` brand buttons
- `data-table.tsx` — generic read-only table (blue accent bar, empty state, optional sticky-header scroll); exports `DataTable` / `DataTableRow`
- `forecast-card-shell.tsx` — shared shell for the forecast/reasoning cards (tone gradient + top bar + status dot + phase + scroll passthrough)
- `grid-background.tsx` — light paper-grid background
- `language-toggle.tsx` — zh/en capsule switcher
- `liquid-glass-card.tsx` — frosted-glass card
- `markdown.tsx` — react-markdown + GFM rendering, elements mapped to shadcn-style classes
- `toast.tsx` — `ToastProvider` + `useToast()` (success/error/info)
- `weather-city-card.tsx` — per-city three-source current-weather card; also exports shared `WEATHER_SOURCES` / `SOURCE_COLORS`

### `components/ui/` — shadcn primitives
`breadcrumb` / `button` / `card` / `chart` / `dialog` / `input` / `label` / `select` / `skeleton` / `table` / `tooltip` — thin presentational wrappers over `@base-ui/react` (use variants/className; don't modify the source).

---

## 9. `hooks/` — React hooks

### `use-forecast-stream.ts`
- `useForecastStream({cityId, locale, model, onDone, onError})` — consumes the SSE stream: POST `/api/ai-agent/forecast`, reads chunks via `getReader`, reuses `lib/weather/sse` parsing; `delta` appends markdown, `thought` opens a new reasoning step, `tool` joins the current step, `rollback` trims thought text; returns `{state, start, cancel, reset}`
- `state.status`: idle/streaming/done/error. This is the sanctioned exception to "no bare fetch in the client" (TanStack Query can't carry true streaming)

### `use-model-config.ts`
- `useModelConfig(email)` — `useSyncExternalStore` over the local model config; null on SSR, reads localStorage after mount, auto-refreshes on save/clear

### `use-element-height.ts`
- `useElementHeight()` — ResizeObserver tracks the element's live height, returns `{ref, height}`; `useLayoutEffect` measures before first paint

---

## 10. `i18n/` — Internationalization

### `routing.ts`
- `routing` — `defineRouting({locales:["zh","en"], defaultLocale:"zh", localePrefix:"as-needed"})` (zh without prefix, en at /en)

### `navigation.ts`
- Exports typed `Link` / `redirect` / `usePathname` / `useRouter` / `getPathname` (locale prefixes handled automatically, never hand-build URLs)

### `request.ts`
- `getRequestConfig` — takes the locale from route params, 404 when unsupported; loads `messages/{locale}.json`

### `messages/zh.json` / `messages/en.json` — copy resources (page/form/error i18n keys)

---

## 11. `scripts/` and root files

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

## 12. `supabase/migrations/` — DB migrations

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

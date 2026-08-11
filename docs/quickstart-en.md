# WeatherMind — Developer Overview

A quick overview for developers. Start with the "Core Flows" diagrams to understand the implementation, then use the "Code Map" to locate the code.

## What This Is

WeatherMind is a **multi-source weather dashboard with AI day-forecast**:

- Collects weather daily from three providers — Open-Meteo / OpenWeatherMap / WeatherAPI.com — normalizes it, and writes it to Supabase;
- The frontend shows realtime weather cards per "city × source" and the last 7 days of history;
- The core feature **ForecastAgent** produces a day forecast with a "deterministic weighted ensemble + AI plain-language interpretation": numbers first, prose second, fully reproducible.

Stack: Next.js 16 (App Router) + React 19 + Tailwind 4 + shadcn/ui (on @base-ui/react) + pnpm + TS strict, light mode only.
Supabase (auth + Postgres + RLS), TanStack Query/Form, Zod, next-intl (zh default, no prefix; en at `/en`), Vitest.

## Core Flows

### 1. Weather Ingestion — where the data comes from

Two triggers share one pipeline, `runWeatherPipeline(trigger)`:

- **Scheduled**: GitHub Actions runs `scripts/weather-cron.ts` daily at 15:00 UTC (JST midnight), outside the deployed environment;
- **Manual**: the "Refresh" button on the forecast page (admin-only) → `refreshWeatherAction`.

```mermaid
flowchart LR
    A["GitHub Actions daily<br/>weather-cron.yml → scripts/weather-cron.ts"] --> P
    B["Admin clicks Refresh<br/>refreshWeatherAction"] --> P
    P["runWeatherPipeline<br/>lib/weather/pipeline.ts"] --> C["Read active cities cities.is_active"]
    C --> F["Concurrent fetch city × source<br/>providers/*"]
    F --> H["fetchJson single wrapper<br/>lib/weather/http.ts<br/>never throws / no-store / timeout"]
    H --> Z["Zod safeParse provider response"]
    Z --> M["Normalize to NormalizedWeather<br/>mapping codes→category<br/>daily group by city-local day"]
    M --> W["Persist<br/>weather_current realtime upsert<br/>weather_daily snapshot upsert"]
    W --> Cl["Prune snapshots older than 7 days"]
    Cl --> R["Write weather_runs record"]
```

Key points:

- **Adding a source is cheap**: implement one `ProviderAdapter` (`source` / `fetchCurrentAndForecast` / `fetchDailyHistory`) and register it in the `providers` array;
- **Failure isolation**: a failed cell counts as one error (missingKey / network / http / parse / noData / db); the run continues and never throws; terminal status success / partial / failed is written to `weather_runs`;
- **Writer side**: the service_role client (`supabase/service.ts`) bypasses RLS; manual triggers go through the admin whitelist (`lib/weather/admin.ts`).

### 2. ForecastAgent — how the day forecast is produced

**Positioning: not a general-purpose chat agent, but a "deterministic compute engine + AI interpreter" split.** All weather numbers come from a math kernel (reproducible, unit-tested, auditable); AI only translates the metrics into plain language, inside a **bounded, read-only ReAct loop** — its two tools re-read only the kernel's data (never compute), the call is streaming with `temperature=0`, and the output is a pure Markdown document. The LLM can never fabricate numbers.

**Streaming pipeline** ("write-once, read-many": the first user to click "Generate" claims the row and runs the generation; everyone after just reads. The generation streams over SSE, so the user watches the reasoning and the Markdown arrive token by token):

```mermaid
flowchart LR
    U["User clicks Generate<br/>forecast-view.tsx → useForecastStream"] --> POST["POST /api/ai-agent/forecast<br/>route.ts self-auth createClient + getUser"]
    POST --> ST["runForecastAgentStream<br/>lib/forecast-agent/stream/stream.ts"]
    ST --> R["readForecast<br/>city×day×locale"]
    R -->|"success / pending"| DUP["duplicate event<br/>return as-is, no regeneration"]
    R -->|"none"| CL["claimPending<br/>unique key city×day×locale"]
    R -->|"failed"| CD["cooldown check<br/>isWithinRetryCooldown<br/>5-min ban after failure"]
    CD -->|"cooling"| CDERR["error: retry-cooldown"]
    CD -->|"cooldown elapsed"| CL
    CL --> SI["buildSourceInputs<br/>per-source snapshot (weather_daily + weather_current)"]
    CL --> SI["buildSourceInputs<br/>per-source snapshot (weather_daily + weather_current)"]
    SI --> W["computeWeights<br/>prior + consistency + truth MAE (α/β/γ)"]
    W --> PRED["predict deterministic ensemble<br/>engine/ensemble.ts"]
    PRED --> P["buildForecastAgentMessages<br/>metric table + ReAct protocol + divergence block"]
    P --> RL["runReActLoopStream ≤4 steps<br/>tools query_source / get_metric<br/>temperature=0, streaming"]
    RL --> VAL["validateMarkdownDoc<br/>two sections + number tolerance"]
    VAL -->|"pass"| OK["settle success<br/>metrics + markdown_body + react_trace + tokens"]
    VAL -->|"reject"| ERR["settle failed + failed_at<br/>error event"]
```

**Step by step** (core streaming state machine in `lib/forecast-agent/stream/stream.ts`, DB primitives in `db/db.ts`):

1. **Read existing** (`readForecast`) — query the prediction row by city×day×locale: success/pending is returned as a `duplicate` event, no regeneration;
2. **Failure cooldown** (`db/db.ts` `isWithinRetryCooldown`) — a `failed` row within 5 minutes of its `failed_at` returns `retry-cooldown`, blocking failed-retry loops that would hammer the server (normal usage is unlimited; already-generated rows are just re-read). Once the cooldown elapses, the row is claimed and regenerated;
3. **Claim the pending row** (`claimPending`) — insert hits the unique key (city_id, day, locale); a `23505` conflict means someone else already claimed it, so read back the existing row; a `failed` row is flipped back to pending with `failed_at`/`error_code` cleared for regeneration, and a generation failure settles the row as `failed` + `failed_at` (the cooldown clock) instead of deleting it;
4. **Build today's per-source snapshot** (`buildSourceInputs`) — high/low/precip/condition from `weather_daily`, humidity/wind from today's `weather_current` snapshot (null when missing; the ensemble just skips them);
5. **Source-count check** — fewer than 2 sources for the day is treated as invalid → `insufficient-data`, no deterministic conclusion;
6. **Weight synthesis** (`engine/weights.ts` `computeWeights`) — `prior PRIOR + last-6-days consistency (leave-one-out deviation) + truth MAE`, blended by α/β/γ against the number of truth days: <7 days relies almost entirely on prior + consistency; ≥30 days MAE dominates;
7. **Deterministic ensemble** (`engine/ensemble.ts` `predict`, all pure functions, unit-tested) —
   - weighted mean: high / low / precip / wind / humidity;
   - precipitation probability: weight share of sources reporting rain (daily precip ≥0.1mm), 0-100;
   - condition: weighted majority vote (sources with a missing condition are skipped);
   - prediction interval: mean ± 1.28 × weighted std (≈80% confidence);
   - confidence: majority weight share (high ≥75% / medium ≥50% / low), independent of historical truth;
   - risk flags: thresholds (high ≥35°C / low ≤0°C / heavy rain ≥25mm / wind ≥Bft 6 / storm / snow / diurnal ≥10°C) + at least 2 agreeing sources, to avoid a single-source false alarm;
8. **Build the prompt** (`agent/prompt.ts`) — see "Prompt engineering" below;
9. **Streaming ReAct loop** (`agent/react-stream.ts` `runReActLoopStream`, max 4 steps) — each step streams a `chatCompletionStream` call (`agent/chat-stream.ts`: SSE, or a single-JSON degrade when the provider ignores `stream`; `temperature=0`, 45s timeout). If the model requests tools, `agent/react.ts` executes them (bad calls are fed back as error observations for self-correction) and the loop continues; otherwise the step's content is the final Markdown document, streamed out as `delta` events;
10. **Trust-boundary validation** (`lib/schemas/forecast-agent.ts` `validateMarkdownDoc`) — after the full document streams in, a lightweight text check runs (below);
11. **settle** — success writes all metrics + `markdown_body` + `react_trace` + token usage; any failure settles the row as `failed` + `failed_at` (the cooldown clock) and emits an in-band `error` event; a client disconnect mid-stream (aborted `AbortSignal`) deletes the pending row in `finally`, so the day's city×day×locale is never stuck.

**Tools** (`agent/tools.ts`) — read-only, the model's only window into data beyond the metric table; both re-read deterministic kernel output, so the AI never introduces new numbers (arguments validated by JSON-schema + Zod):

- `query_source(source)` — returns one source's raw forecast snapshot (high/low/precip/condition/humidity/wind);
- `get_metric(metricId)` — returns the authoritative value of one platform metric (same numbers as the metric table).

**Divergence detection** (`engine/divergence.ts`) — a pure function over the per-source inputs: precipitation (wet vs dry), condition (more than one non-null category), and temperature (high/low spread ≥3°C). When any divergence exists, the prompt injects a mandatory "verify with query_source before finalizing" block, so divergent days produce real tool steps in the ReAct trace (the tools are load-bearing).

**Prompt engineering** (`agent/prompt.ts` `buildForecastAgentMessages`) — the whole context (metric table / weights / ReAct protocol / divergence block / hard rules) is **assembled in the current language**, so an English UI doesn't let a Chinese data table pull the model into outputting Chinese:

- **Context** = metric table (each row `metricId (label): value ※note`) + weights line + queryable sources + divergence block; per-source raw snapshots are **not** inlined — the model must call `query_source`;
- **Output contract**: exactly one Markdown document with two H2 sections in order — `## Reasoning` (`## 推理过程` in zh) then `## Forecast` (`## 预报` in zh); the forecast is a 2–3 sentence narrative (overview + action advice) that must include the predicted high/low (°C) and PoP (%), but does not re-list the metric table;
- **Hard rules**: numbers only from the metric table (never invent or re-round); risk_flags must be mentioned when non-empty and never fabricated otherwise; never question or belittle the platform metrics — only explain and advise.

**Anti-hallucination backstop: Markdown validation** (`validateMarkdownDoc`) — a machine check over the full document, run after streaming completes; any failure rolls back the row and emits `error: consistency`:

- both sections present, reasoning before forecast;
- forecast section contains a high and low within ±2.5°C of the ensemble, and a PoP within ±10 (unless PoP=0, where "no rain" wording suffices);
- anti-fabrication: all temperatures inside −40…60°C and all percentages ≤100;
- note the reversal vs the old structured output: the forecast text must contain temperatures, so temperature units are no longer banned.

**Why a bounded ReAct loop instead of a single call**: forecast numbers are "facts" that must stay reproducible and auditable, so the model is never asked to compute — the tools exist only to let it verify source-level facts (mandatory on divergent days). The loop is capped (4 steps, no web/search tools), so it cannot wander into open-ended tool use. If the agent later needs to pull supplemental data on its own, more tools can be registered in `buildTools` — but the kernel already covers every displayed metric.

Other points:

- **Self-calibrating weights**: truth comes from the daily cron taking the median of the three sources' observed history into `weather_truth` (`engine/truth.ts` `backfillTruth`, pruned to 31 days); once enough days accumulate, weights automatically shift toward the lower-MAE sources;
- **Model config**: users bring their own OpenAI-compatible baseUrl/key, stored per-email in localStorage (`lib/model-config.ts`); every server-side call runs an SSRF guard first (https only + private-network block for IPv4/IPv6 + DNS re-check, `agent/ssrf.ts` + `agent/dns.ts`);
- **Timezone invariant** (migration `0011_city_timezone_check.sql`): the weight window / truth rotation are hard-coded to Asia/Tokyo, so `cities.timezone` is constrained by a CHECK to `'Asia/Tokyo'` — a guard against future non-Tokyo cities breaking day alignment;
- **Streaming + disconnect safety**: the SSE generator forwards the client's `AbortSignal`; on disconnect or unexpected error the `finally` block deletes the still-pending row, so the same city×day×locale can always be retried.

### 3. Requests & Auth — who sees what

```mermaid
flowchart LR
    REQ["Browser request"] --> PROXY["proxy.ts root middleware<br/>next-intl locale negotiation"]
    PROXY --> SESS["supabase/proxy.ts updateSession<br/>refresh auth cookies (auto-renew expired)"]
    SESS --> GUARD{"Authenticated?"}
    GUARD -->|"not logged in & not whitelisted<br/>(/ login /register /forgot-password)"| REDIR["303 redirect to landing page"]
    GUARD -->|"logged in"| DASH["/dashboard and subpages"]
    DASH --> RSC["Server Component session reads<br/>supabase/server.ts createClient"]
    DASH --> ACT["Server Action<br/>second gate (admin / email)"]
```

- Writes go through the service_role client bypassing RLS (`supabase/service.ts`, **server-only import**); reads go through the authenticated role + RLS (0003_rls.sql);
- Admin gating is double: the UI hides the buttons and the actions reject direct calls (`lib/weather/admin.ts`);
- `/api` route handlers **bypass the proxy middleware** and self-authenticate: `app/api/ai-agent/forecast` uses `createClient` + `getUser` and re-validates the model config schema server-side before streaming (pre-stream failures return non-2xx JSON; errors after streaming starts travel as in-band SSE events).

## Code Map (path — what it does)

### Auth

- `proxy.ts` — root middleware: locale negotiation + session refresh + route guard
- `supabase/proxy.ts` — `updateSession`: syncs auth cookies on the response, auto-renews expired tokens
- `supabase/server.ts` — `createClient`: server session client (RSC / Server Action)
- `supabase/service.ts` — `createServiceClient`: service_role client, bypasses RLS (server-only)
- `supabase/auth/actions.ts` — login / two-step register / forgot-password server actions
- `supabase/auth/errors.ts` — `mapAuthError`: Supabase errors → restricted codes
- `lib/schemas/auth.ts` — auth form Zod schemas

### Weather ingestion pipeline

- `lib/weather/pipeline.ts` — entry: `runWeatherPipeline` (collect) / `runWeatherBackfill` (history backfill); concurrent city×source fetch, persist, prune, write run records, never throws
- `lib/weather/http.ts` — `fetchJson` / `fetchStream`: the single fetch wrappers (check `res.ok` first, `cache:no-store`, optional timeout, never throws; `fetchStream` reads no body — caller consumes `response.body.getReader()` for SSE, and sets `redirect:manual` against SSRF redirects)
- `lib/weather/providers/index.ts` — `ProviderAdapter` contract + 3-provider registry
- `lib/weather/providers/open-meteo.ts` — keyless provider adapter (naive local time → UTC)
- `lib/weather/providers/openweather.ts` — OpenWeatherMap adapter
- `lib/weather/providers/weatherapi.ts` — WeatherAPI.com adapter (km/h → m/s)
- `lib/weather/mapping.ts` — provider condition codes → 8 coarse categories, unit conversions
- `lib/weather/sse.ts` — SSE frame parsing pure functions (`splitSseEvents` / `extractDataPayloads` / `isDonePayload`), shared by the AI provider stream and the frontend hook
- `lib/weather/daily.ts` — group by city-local day, today-snapshot aggregation, window helpers
- `lib/weather/actions.ts` — `refreshWeatherAction` / `backfillWeatherAction` (admin manual trigger)
- `lib/weather/admin.ts` — admin whitelist (`isAdminEmail`)
- `lib/weather/city-actions.ts` — city create/delete (admin + service write, FK cascade clears data)
- `lib/weather/resolve-city.ts` — resolve `?city=` to a unique city and normalize the URL
- `lib/weather/view-types.ts` — DB row types asserted at the view boundary (no generated Database types)
- `lib/weather/errors.ts` — action error classes (WeatherError / CityError)

### Data model (shared Zod, frontend + backend)

- `lib/schemas/weather.ts` — canonical `NormalizedWeather` (UTC ISO times, metric units, original condition codes + coarse category)
- `lib/schemas/city.ts` — city form schema
- `lib/schemas/forecast-agent.ts` — prediction row types, `METRICS` id constants, chat response schema, ReAct trace schema, Markdown validation (`validateMarkdownDoc`)
- `lib/schemas/ai.ts` — model config schema, `/models` response schema

### ForecastAgent

- `app/api/ai-agent/forecast/route.ts` — streaming endpoint: POST → SSE (`runForecastAgentStream`); self-auth via `createClient` + `getUser`, re-validates model config, forwards client `AbortSignal`
- `lib/forecast-agent/stream/stream.ts` — `runForecastAgentStream`: the single generation entry (async generator of SSE events); read → claim → ensemble → ReAct → validate → settle, failure rolls back by deleting the pending row
- `lib/forecast-agent/db/db.ts` — persistence primitives: `readForecast` / `claimPending` (23505 → read back; legacy failed → pending) / `settleRow` / `buildSourceInputs`
- `lib/forecast-agent/engine/ensemble.ts` — deterministic ensemble: weighted mean / PoP / majority vote / range / confidence / risk flags
- `lib/forecast-agent/engine/weights.ts` — source weights: prior + consistency + truth MAE, α/β/γ blend (rolling window aligned to Asia/Tokyo)
- `lib/forecast-agent/engine/divergence.ts` — source-divergence detection (precip / condition / temperature spread), forces `query_source` verification in the prompt
- `lib/forecast-agent/engine/truth.ts` — reference-truth backfill (median of 3 providers' history → `weather_truth`, pruned to 31 days)
- `lib/forecast-agent/agent/prompt.ts` + `prompt-text.ts` — locale-aware prompt (metric table / weights / ReAct protocol / divergence block) + localized templates
- `lib/forecast-agent/agent/react.ts` — ReAct core: types, JSON parse, usage merge, tool execution (shared with the stream)
- `lib/forecast-agent/agent/react-stream.ts` — streaming ReAct loop (≤4 steps): `delta` / `thought` / `rollback` / `tool` / `result` events
- `lib/forecast-agent/agent/chat-stream.ts` — OpenAI-compatible streaming chat (SSE, or single-JSON degrade) + SSRF guard
- `lib/forecast-agent/agent/chat.ts` — wire message/tool conversion, request body, `assertPublicBaseUrl` preflight (shared with chat-stream)
- `lib/forecast-agent/agent/tools.ts` — read-only tool registry: `query_source` / `get_metric` (arguments validated by JSON-schema + Zod)
- `lib/forecast-agent/agent/ssrf.ts` — SSRF host allowlist (https only, IPv4/IPv6 private/reserved block, DNS re-check)
- `lib/forecast-agent/agent/dns.ts` — single DNS-resolution entry (SSRF DNS re-check)
- `lib/forecast-agent/db/db.ts` — prediction-row primitives (read/claim/settle) + failure cooldown `isWithinRetryCooldown` (5 min) + `RETRY_COOLDOWN_MS`
- `lib/forecast-agent/common/errors.ts` — `ForecastAgentErrorCode` external contract (no-model / retry-cooldown / insufficient-data / provider / parse / consistency / react-loop / generic)
- `lib/model-config.ts` — per-email localStorage model config + `/models` listing

### Pages & components

- `app/[locale]/dashboard/forecast/page.tsx` — forecast page RSC: single-city current weather + latest run (no preloaded forecast row — the client streams it)
- `components/dashboard/forecast/forecast-view.tsx` — forecast client view: city switch / refresh / trigger ForecastAgent via SSE stream
- `components/dashboard/forecast/forecast-agent-card.tsx` — result card: metric icon grid + streaming Markdown body (`## Reasoning` / `## Forecast`); legacy structured rows fall back to summary/points/advice
- `components/dashboard/forecast/forecast-metrics-grid.tsx` — 9 authoritative metric icon cards (high/low/PoP/precip level/condition/wind/humidity/confidence/risk)
- `components/dashboard/forecast/forecast-reasoning-card.tsx` — ReAct trace card (thought / tool call / observation), streams live
- `components/ui-preset/forecast-card-shell.tsx` — shared card shell (tone / status dot / phase label)
- `components/ui-preset/markdown.tsx` — Markdown renderer (react-markdown + remark-gfm), styled with shadcn tokens
- `hooks/use-forecast-stream.ts` — SSE consumption hook (POST `/api/ai-agent/forecast`, split frames, `delta` → Markdown, `thought`/`tool` → steps, `rollback` trims thought text)
- `hooks/use-model-config.ts` / `hooks/use-element-height.ts` — model-config subscription / left-card height observation
- `app/[locale]/dashboard/history/page.tsx` — history page RSC: last 7 days of daily snapshots
- `components/dashboard/history/history-view.tsx` — history table + charts
- `app/[locale]/dashboard/cities/page.tsx` — city list page; `components/dashboard/cities/*` — list + add/delete dialog
- `app/[locale]/dashboard/logs/page.tsx` — run-logs page (admin, latest 100 `weather_runs`)
- `app/[locale]/dashboard/settings/page.tsx` — settings page; `components/dashboard/settings/model-config-card.tsx` — model config form
- `app/[locale]/dashboard/layout.tsx` — dashboard layout (sidenav + login guard)
- `i18n/routing.ts` — next-intl routing (zh default / en)

### Scheduled tasks & CI

- `scripts/weather-cron.ts` — daily ingestion entry: run pipeline + backfill truth; exits non-zero when everything failed
- `.github/workflows/weather-cron.yml` — daily 15:00 UTC (JST midnight), injects secrets, runs collection
- `.github/workflows/ci.yml` — typecheck / lint / build + coverage tests reported to Codecov
- `.github/workflows/stryker.yml` — PR-scoped mutation testing (only mutates changed files that have tests)

### Database (`supabase/migrations/`, run in order)

- `0001_weather.sql` — cities / weather_current / weather_runs + 8 Japanese city seeds
- `0002_weather_daily.sql` — daily snapshot table (unique city×source×day)
- `0003_rls.sql` — enable RLS: authenticated read-only
- `0004_remove_weather_forecast.sql` — legacy only: drop the deprecated weather_forecast table
- `0005_email_registered.sql` — `is_email_registered` RPC (registration pre-check, service_role only)
- `0006_forecast_agent.sql` — predictions table (unique city×day) + truth table
- `0007_forecast_agent_locale.sql` — predictions gain locale; unique key becomes city×day×locale
- `0008_forecast_agent_tokens.sql` — predictions gain token-usage columns
- `0009_forecast_agent_react_trace.sql` — predictions gain `react_trace` jsonb (ReAct thought/action steps; empty array when the model answers in one step)
- `0010_forecast_agent_markdown.sql` — predictions gain `markdown_body` text (the pure-Markdown output; legacy structured rows keep null)
- `0011_city_timezone_check.sql` — `cities.timezone` CHECK = `'Asia/Tokyo'` (timezone invariant: weight window / truth rotation are hard-coded to Tokyo)

## Getting Started

```bash
pnpm install
cp .env.example .env.local   # fill in Supabase connection and provider keys, see below
```

1. Supabase Dashboard → SQL Editor: run migrations in order 0001 → … → 0011;
2. `pnpm dev` — register an account to reach the dashboard; configure an OpenAI-compatible model in "Settings" to use ForecastAgent;
3. Checks: `pnpm typecheck` / `pnpm lint` / `pnpm test` (CI in `.github/workflows/ci.yml`).

### Environment Variables

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase connection (public, RLS-guarded) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only service_role key for pipeline writes / city add-delete; **no `NEXT_PUBLIC_` prefix, never import in client code** |
| `OPENWEATHER_API_KEY` | OpenWeatherMap provider (server-side) |
| `WEATHERAPI_API_KEY` | WeatherAPI.com provider (server-side) |

## Conventions

- Error handling: server actions / the pipeline return result objects with restricted codes, **never throw across the RPC boundary**; clients throw the matching Error class on `!ok` to drive toasts
- Zod only at trust boundaries (external responses / forms / route params), prefer `safeParse`; trusted internal data is not parsed
- All networking goes through `fetchJson` in `lib/weather/http.ts`
- Writes via service_role, reads via authenticated + RLS; `supabase/service.ts` is server-only import
- Copy lives in `i18n/messages/{zh,en}.json`; navigate with `Link` / `useRouter` from `@/i18n/navigation`
- Logic code uses concise Simplified-Chinese comments; commits use Conventional Commits

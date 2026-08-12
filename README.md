# 🌤️ WeatherMind

**English** · [简体中文](./README.zh-CN.md)

WeatherMind is a multilingual weather intelligence dashboard. It aggregates weather data from multiple providers, keeps daily history in Supabase, and layers on two AI agents — a **forecast analysis agent** and a **chat assistant** — built on a shared streaming ReAct (Reasoning + Acting) core.

---

## ✨ Features

- **Multi-source weather aggregation** — Open-Meteo, OpenWeatherMap and WeatherAPI.com are wired in through a uniform provider-adapter contract; every request goes through one HTTP wrapper and every response is normalized into a single data model.
- **Daily history & backfill** — a scheduled job collects daily aggregates for your tracked cities; history is shown in tables and Recharts visualizations.
- **Deterministic forecast engine** — an ensemble engine that combines model outputs with weights, detects divergence between sources, and truth-checks forecasts against actual observations.
- **AI forecast interpretation** — a streaming ReAct agent reads the ensemble result and explains what it means in plain language, with a step-by-step reasoning trace.
- **AI chat assistant** — an SSE-streamed conversation agent with tools, backed by persisted conversations in Supabase.
- **Shared agent infrastructure** — one `agent-core` layer powers both agents: LLM chat calls, a streaming ReAct loop, multi-agent orchestration, and SSRF / DNS-rebinding protections.
- **BYO model** — configure any OpenAI-compatible endpoint + model in Settings (stored per-account in the browser).
- **i18n (中文 / English)** — Chinese is the default locale with no prefix; English lives under `/en`.
- **Auth & security** — Supabase Auth (email/password), Row Level Security, and a separate `service_role` path used only by server-side cron writes.
- **Tested** — Vitest unit/component/integration tests, Stryker mutation testing, and a Codecov coverage gate in CI.

## 🛠 Tech Stack

| Layer       | Tools |
| ---         | --- |
| Framework   | Next.js 16.2 (App Router), React 19.2, TypeScript (strict) |
| Styling     | Tailwind CSS 4, shadcn/ui |
| Data        | Supabase (Postgres, Auth, RLS), TanStack Query / Form, Zod (shared schemas) |
| AI          | Any OpenAI-compatible LLM API (endpoint/key/model configured in-app) |
| i18n        | next-intl (zh default, `/en` prefix) |
| Testing     | Vitest, Stryker, Codecov |
| Charts      | Recharts, react-markdown + remark-gfm |
| Tooling     | pnpm, ESLint, Prettier, Conventional Commits |

## 📁 Project Structure

```
app/[locale]/            Pages — auth (login/register/forgot-password) + dashboard
                         (overview, cities, forecast, history, logs, ai-agent, settings)
app/api/ai-agent/        Server routes — /forecast, /chat (self-authenticating, not via proxy)
lib/weather/             Provider adapters (open-meteo / openweather / weatherapi)
                         + the single fetch wrapper + normalize/aggregate pipeline
lib/agent-core/          Shared AI infrastructure — chat, ReAct loop, orchestration, SSRF, DNS
lib/forecast-agent/      Forecast integration engine (ensemble/weights/divergence/truth)
                         + streaming AI interpretation
lib/ai-agent/            AI chat assistant — prompts/tools, conversation persistence, SSE
lib/schemas/             Shared Zod schemas (frontend + backend)
lib/model-config.ts      Per-account model config (OpenAI-compatible), stored in localStorage
scripts/                 weather-cron.ts — scheduled daily collection
supabase/                server.ts (session) / service.ts (service_role writes)
                         / proxy.ts (auth + token refresh) + migrations/
i18n/                    next-intl routing + zh/en messages
.github/workflows/       ci.yml, stryker.yml, weather-cron.yml
```

## 🚀 Getting Started

### Prerequisites

- Node.js 20+ and pnpm
- A Supabase project (or the [Supabase CLI](https://supabase.com/docs/guides/local-development))
- Weather API keys — **Open-Meteo is free and needs no key**; OpenWeatherMap / WeatherAPI.com only if you want those sources

### Install

```bash
pnpm install
```

### Database

Apply the SQL migrations in `supabase/migrations/` (in order) to your Supabase project, then copy `.env.example` to `.env.local` and fill in:

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public anon key (browser-safe, constrained by RLS) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only `service_role` key (cron collection / admin writes) — never expose to the browser |
| `OPENWEATHER_API_KEY` | Optional — OpenWeatherMap key |
| `WEATHERAPI_API_KEY` | Optional — WeatherAPI.com key |

### Run

```bash
pnpm dev        # dev server
pnpm build      # production build
pnpm start      # start the production server
```

The AI agents need a model configuration — set an OpenAI-compatible **endpoint + API key + model** in the dashboard **Settings** page (stored per-account).

## 📅 Scheduled Collection

`scripts/weather-cron.ts` collects daily weather history for tracked cities. It runs daily via the `weather-cron.yml` GitHub Action and uses `SUPABASE_SERVICE_ROLE_KEY` to write past RLS.

## 🧪 Testing

```bash
pnpm test              # Vitest unit/component/integration tests
pnpm test:coverage     # with coverage (lib/ + supabase/ counted)
pnpm test:stryker      # Stryker mutation testing
```

- Coverage targets `lib/**` and `supabase/**`; Codecov enforces a `target:auto` + `threshold:1%` gate.
- Stryker runs on PRs against changed files that have tests (see `stryker.yml`).

## 🔧 Common Commands

```bash
pnpm lint          # ESLint
pnpm format        # Prettier
pnpm typecheck     # next typegen + tsc --noEmit
```

## 📚 Documentation

For humans: `docs/developer-{zh,en}.md` (module documentation) and `docs/quickstart-{zh,en}.md` (core data flow & code map).

## 🤝 Contributing

This project follows [Conventional Commits](https://www.conventionalcommits.org/). Logic comments are written in Simplified Chinese; keep new code consistent with the surrounding style. See `docs/developer-zh.md` for module conventions.

## 📄 License

Private project — see repository owner for licensing.

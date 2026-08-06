# WeatherMind — Developer Quick Start

A project overview for developers. Read "Core Flows" first, then "Conventions" before touching code.

## Tech Stack

Next.js 16.2.6 (App Router) + React 19 + Tailwind CSS 4 + shadcn/ui (based on @base-ui/react) + pnpm + TypeScript strict. Light mode only.
Supabase (auth + Postgres), TanStack Query / TanStack Form, Zod, next-intl (default zh; English at `/en`).

## Getting Started

```bash
pnpm install
cp .env.example .env.local   # fill in real values, see "Environment Variables"
```

1. In Supabase Dashboard → SQL Editor, run the migrations in order (`lib/supabase/migrations/`):
   - **Fresh DB**: `0001_weather.sql` → `0002_weather_daily.sql` → `0003_rls.sql`
   - `0004_remove_weather_forecast.sql` is only for legacy DBs that still have the deprecated `weather_forecast` table; skip it on fresh DBs
   - The migrations create 4 tables (cities / weather_current / weather_runs / weather_daily) and seed 8 Japanese cities
2. `pnpm dev` — register an account to reach the dashboard
3. Checks: `pnpm typecheck` / `pnpm lint` / `pnpm test` (CI in `.github/workflows/ci.yml`)

### Environment Variables

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase connection (public, RLS-guarded) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only service_role key: bypasses RLS for pipeline writes / city add-delete; no `NEXT_PUBLIC_` prefix, never import in client code |
| `OPENWEATHER_API_KEY` | OpenWeatherMap provider (server-only) |
| `WEATHERAPI_API_KEY` | WeatherAPI.com provider (server-only) |
| `WEATHER_CRON_SECRET` | Guard header for the cron route; route is always 401 if unset |

## Directory Map

- `proxy.ts` — middleware: i18n negotiation + Supabase session refresh + route guard
- `lib/supabase/` — auth server actions, session proxy (`proxy.ts`), service_role client (`service.ts`), error mapping, migrations
- `lib/weather/` — weather ingestion pipeline (pipeline / providers / mapping / daily / http) and admin actions (admin / actions / city-actions)
- `lib/schemas/` — shared Zod schemas (auth, weather, city)
- `app/api/cron/weather/` — external scheduled-task entry point (self-authenticated)
- `.github/workflows/` — `ci.yml` (CI), `weather-cron.yml` (daily scheduled collection)
- `i18n/` — next-intl config and copy (zh/en JSON)

## Core Flows

### 1. Auth (login / register / forgot password)

Form (TanStack Form + Zod) → useMutation calls a server action → Supabase auth.

```
Client form → Server Action(lib/supabase/auth/actions.ts) → supabase.auth.*
           → { ok } | { ok: false, error: restrictedErrorCode }
```

- **Server never throws**: actions return a result object; errors are mapped to restricted codes (`mapAuthError` in `lib/supabase/auth/errors.ts`) so raw details never leak to the user
- **Client**: `!res.ok` throws `AuthError(code)`; toast looks up the i18n copy by code
- **Two-step flows**: register = send code → verify code; forgot password = send code (detects "new password == old password" by trying to log in with the new one; if equal, no code is sent) → verify code + update password + re-login as fallback
- **Route guard** (`proxy.ts`): unauthenticated users may only visit `/` `/login` `/register` `/forgot-password`; everything else redirects to the landing page. Authenticated users visiting those pages go to `/dashboard`

### 2. Weather Ingestion Pipeline (core)

Two entry points, one shared `runWeatherPipeline(trigger)` (`lib/weather/pipeline.ts`):

- **Manual**: dashboard forecast page "Refresh" button (admin-only) → `refreshWeatherAction` (`lib/weather/actions.ts`)
- **Scheduled**: GitHub Actions daily trigger (`.github/workflows/weather-cron.yml`) GET `/api/cron/weather` with `x-weather-cron-secret` header (no user session)

```
Read active cities (cities.is_active)
  → for each city × provider, fetch concurrently (providers/*)
      fetchJson (single wrapper in http.ts, never throws)
        → Zod-parse the provider response
        → map to canonical NormalizedWeather (mapping.ts)
        → persist: weather_current upsert + weather_daily daily-snapshot upsert
  → prune daily snapshots older than 7 days (keep the window bounded)
  → aggregate per-cell results → write weather_runs record
```

- **Providers**: Open-Meteo (no key), OpenWeatherMap, WeatherAPI.com (both need keys); registry in `providers/index.ts` — adding a source only requires a new adapter
- **Failure isolation**: a failed cell counts as one error (codes: missingKey / network / http / parse / noData / db); the run continues, never throws
- **Run status**: all success → `success`, all failed → `failed`, otherwise `partial`; every run is recorded in `weather_runs`
- **Persistence**: `weather_current` upserts on `(city_id, source)` keeping the latest value; `weather_daily` upserts on `(city_id, source, day)` overwriting the current day (aggregated per city-local day in `daily.ts`; falls back to realtime data when the day has no forecast slot)
- **Permissions**: the pipeline writes through the service_role client (`lib/supabase/service.ts`) to bypass RLS; manual triggers are restricted to the admin whitelist (`lib/weather/admin.ts`)

### 3. Data Model & Cross-Source Normalization

Canonical schema in `lib/schemas/weather.ts`, normalizing all three sources into `NormalizedWeather`:

- **All timestamps are UTC ISO** (Z suffix) to avoid each source's local time causing a +9h drift (Open-Meteo's naive local times go through `toUtcIso`)
- **Metric units everywhere**: temperature °C, wind m/s (WeatherAPI's km/h converted via `kphToMps`), pressure hPa, precipitation mm
- **conditionCode / conditionLabel keep the source's original values**; cross-source comparison only uses `conditionCategory` (mapping.ts maps each source's codes into 8 coarse categories: clear / partlyCloudy / cloudy / fog / rain / snow / storm / other)

### 4. Dashboard

- After auth you land in `/dashboard`; the sidenav has 6 items: dashboard, AI agent, cities, forecast, history, settings (dashboard / AI agent / settings are placeholders, see `components/dashboard/page-placeholder.tsx`)
- `/cities` — city list; admins can add/delete cities (`createCityAction` / `deleteCityAction`, `lib/weather/city-actions.ts`), regular users are read-only; "Show forecast / Show history" links navigate with the city preselected
- `/forecast` — a server component reads `cities` + `weather_current` + latest `weather_runs`, then hands data to the client `ForecastView`, which renders "city × 3 sources" cards; supports `?city=<name_en>` preselection; the "Refresh" button is a useMutation calling `refreshWeatherAction` (admin-only), and `router.refresh()` re-fetches server data on success
- `/history` — a server component reads the last 7 days of `weather_daily`, switchable by city / source to show daily high/low and conditions
- Server query results are asserted as typed rows in `lib/weather/view-types.ts` (no generated Database types)

## Conventions (read before changing code)

- **Error handling**: server actions / the pipeline return result objects or restricted error codes and never throw across the RPC boundary; clients throw the matching Error class on `!ok` to drive toasts
- **Zod only at trust boundaries**: API responses, forms, route params; trusted internal data is not re-parsed; prefer `safeParse`
- **Forms**: TanStack Form + Zod + useMutation — no hand-rolled validation
- **Networking**: single `fetchJson` wrapper (`lib/weather/http.ts`) — check `res.ok` before `res.json()`, `cache: "no-store"` (weather must be fresh)
- **RLS is enabled** (`0003_rls.sql`): reads go through the authenticated role (the middleware already guarantees login); writes go through service_role only (`service.ts` is server-only — **never import it in client code**)
- **Admin gate**: manual refresh and city add/delete are restricted to the admin whitelist (`lib/weather/admin.ts`); the UI hides the buttons and the actions reject direct calls — defense in depth
- **Security**: auth is enforced centrally by the `proxy.ts` middleware; `/api` routes are outside the middleware matcher and must self-authenticate (cron checks the `x-weather-cron-secret` header)
- **i18n**: copy lives in `i18n/messages/{zh,en}.json`; navigate with `Link` / `useRouter` from `@/i18n/navigation`, never hand-build the locale prefix
- Generated logic code uses concise Simplified-Chinese comments; commits use Conventional Commits

## Adding a City / Provider

- **New city**: admins add it via the `/cities` page form (`createCityAction`, lat/lon and timezone validated by schema); or insert a row directly into `cities` (name_ja / name_en / latitude / longitude / timezone)
- **New provider**: add an adapter in `lib/weather/providers/` implementing the `ProviderAdapter` contract (source / fetchCurrentAndForecast), register it in the `providers` array; if needed, add code mapping in `mapping.ts` and a new value in the source `check` constraint in the migration SQL

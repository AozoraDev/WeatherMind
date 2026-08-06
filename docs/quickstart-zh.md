# WeatherMind 开发快速上手

面向开发人员的项目速览。先看「核心业务流」再补「关键约定」即可上手。

## 技术栈

Next.js 16.2.6（App Router）+ React 19 + Tailwind CSS 4 + shadcn/ui（@base-ui/react）+ pnpm + TypeScript strict。仅浅色模式。
Supabase（认证 + Postgres）、TanStack Query / TanStack Form、Zod、next-intl（默认 zh，英文走 `/en`）。

## 快速开始

```bash
pnpm install
cp .env.example .env.local   # 填真实值，见「环境变量」
```

1. 在 Supabase Dashboard → SQL Editor 按顺序执行迁移（`lib/supabase/migrations/`）：
   - **新库**执行 `0001_weather.sql` → `0002_weather_daily.sql` → `0003_rls.sql`
   - `0004_remove_weather_forecast.sql` 只给旧库（存在已废弃的 weather_forecast 表）执行，新库跳过
   - 迁移建 4 张表（cities / weather_current / weather_runs / weather_daily）并种入 8 个日本城市
2. `pnpm dev` 启动，注册账号后进仪表盘
3. 常用校验：`pnpm typecheck` / `pnpm lint` / `pnpm test`（CI 见 `.github/workflows/ci.yml`）

### 环境变量

| 变量 | 用途 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase 连接（公开，受 RLS 约束） |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role 服务端专用密钥：绕过 RLS，管道落库 / 城市增删用；勿加 `NEXT_PUBLIC_` 前缀、勿在客户端 import |
| `OPENWEATHER_API_KEY` | OpenWeatherMap 数据源（服务端专用） |
| `WEATHERAPI_API_KEY` | WeatherAPI.com 数据源（服务端专用） |
| `WEATHER_CRON_SECRET` | cron 路由校验头；未配置时该路由恒 401 |

## 目录速览

- `proxy.ts` — 中间件：i18n 协商 + Supabase 会话刷新 + 路由守卫
- `lib/supabase/` — 认证服务端动作、会话代理（proxy.ts）、service_role 客户端（service.ts）、错误映射、迁移 SQL
- `lib/weather/` — 天气采集管线（pipeline / providers / mapping / daily / http）与管理动作（admin / actions / city-actions）
- `lib/schemas/` — 前后端共享 Zod schema（auth、weather、city）
- `app/api/cron/weather/` — 外部定时任务入口（自鉴权）
- `.github/workflows/` — `ci.yml`（CI）、`weather-cron.yml`（每日定时采集）
- `i18n/` — next-intl 配置与文案（zh/en JSON）

## 核心业务流

### 1. 认证（登录 / 注册 / 忘记密码）

表单（TanStack Form + Zod）→ useMutation 调服务端 Server Action → Supabase auth。

```
客户端表单 → Server Action(lib/supabase/auth/actions.ts) → supabase.auth.*
           → { ok } | { ok: false, error: 受限错误码 }
```

- **服务端从不抛错**：动作返回结果对象，错误统一映射为受限错误码（`mapAuthError`，见 `lib/supabase/auth/errors.ts`），不向用户泄露原始错误
- **客户端**：`!res.ok` 时抛 `AuthError(code)`，toast 按 code 取 i18n 文案
- **两段式流程**：注册 = 发验证码 → 验码；忘记密码 = 发码（用「新密码能否登录」判断新旧密码是否相同，相同则不发码）→ 验码 + 更新密码 + 重新登录兜底
- **路由守卫**（`proxy.ts`）：未登录仅放行 `/` `/login` `/register` `/forgot-password`，其余重定向回落地页；已登录访问这些页则进 `/dashboard`

### 2. 天气采集管线（核心）

两个触发入口，共用同一套 `runWeatherPipeline(trigger)`（`lib/weather/pipeline.ts`）：

- **手动**：仪表盘预报页「刷新」按钮（仅管理员可见）→ `refreshWeatherAction`（`lib/weather/actions.ts`）
- **定时**：GitHub Actions 每日触发（`.github/workflows/weather-cron.yml`）GET `/api/cron/weather`，头带 `x-weather-cron-secret` 自鉴权（无用户会话）

```
读启用城市(cities.is_active)
  → 每城 × 每源并发拉取(providers/*)
      fetchJson(http.ts 统一封装，绝不抛错)
        → Zod 解析源响应
        → 映射为 canonical NormalizedWeather (mapping.ts)
        → 落库：weather_current upsert + weather_daily 当日快照 upsert
  → 清理 7 天前的每日快照（维持窗口有界）
  → 汇总各格成败 → 写 weather_runs 记录
```

- **数据源**：Open-Meteo（免 key）、OpenWeatherMap、WeatherAPI.com（后两者需 key）；注册表在 `providers/index.ts`，加新源只需新增一个 adapter
- **失败隔离**：单格失败只计一格（错误码：missingKey / network / http / parse / noData / db），整轮继续，绝不抛错
- **运行状态**：全成 `success`、全败 `failed`、否则 `partial`；每次运行写 `weather_runs`
- **落库**：`weather_current` 按 `(city_id, source)` upsert 保留最新；`weather_daily` 按 `(city_id, source, day)` upsert 覆盖当日一行（按城市时区归日聚合，见 `daily.ts`；当天预报缺 slot 时用实时数据兜底）
- **权限**：管道用 service_role 客户端（`lib/supabase/service.ts`）写入以绕过 RLS；手动触发限管理员白名单（`lib/weather/admin.ts`）

### 3. 数据模型与跨源归一

canonical schema 见 `lib/schemas/weather.ts`，三源统一为 `NormalizedWeather`：

- **时间一律 UTC ISO**（Z 结尾），避免各源本地时间 +9h 偏移（Open-Meteo 的 naive 本地时间用 `toUtcIso` 换算）
- **单位统一公制**：温度 °C、风速 m/s（WeatherAPI 的 km/h 用 `kphToMps` 换算）、气压 hPa、降水 mm
- **conditionCode / conditionLabel 保留各源原值**；跨源比较只看 `conditionCategory`（mapping.ts 把各源码映射到 8 个粗分类：clear / partlyCloudy / cloudy / fog / rain / snow / storm / other）

### 4. 仪表盘

- 认证后进 `/dashboard`，侧边导航 6 项：仪表盘、AI 助手、城市、预报、历史、设置（其中仪表盘 / AI 助手 / 设置为占位页，见 `components/dashboard/page-placeholder.tsx`）
- `/cities` — 城市列表；管理员可增删城市（`createCityAction` / `deleteCityAction`，`lib/weather/city-actions.ts`），普通用户只读；「显示预报 / 显示历史」跳转对应页并预选城市
- `/forecast` — 服务端组件查 `cities` + `weather_current` + 最近 `weather_runs`，交给客户端组件 `ForecastView` 渲染「城市 × 三源」卡片，支持 `?city=<name_en>` 预选；「刷新」按钮 = useMutation 调 `refreshWeatherAction`（仅管理员），成功后 `router.refresh()` 重拉服务端数据
- `/history` — 服务端组件查近 7 天 `weather_daily`，按城市 / 源切换展示逐日高低温与天气
- 服务端查询结果在 `lib/weather/view-types.ts` 断言为强类型行（无生成的 Database 类型）

## 关键约定（改代码必读）

- **错误模式**：服务端动作 / 管道返回结果对象或受限错误码，不抛错跨 RPC；客户端 `!ok` 时抛对应 Error 类驱动 toast
- **Zod 只在信任边界**：API 响应、表单、路由入参；内部可信数据不重复解析；`safeParse` 优先
- **表单统一**：TanStack Form + Zod + useMutation，不手写校验
- **网络请求统一**：`fetchJson`（`lib/weather/http.ts`），先判 `res.ok` 再 `res.json()`，`cache: "no-store"`（天气要最新）
- **RLS 已启用**（0003_rls.sql）：读走 authenticated 角色（中间件已保证登录态）；写入仅 service_role 绕过（`service.ts` 只在服务端 import，**勿在客户端 import**）
- **管理员门禁**：手动刷新、城市增删均为管理员白名单（`lib/weather/admin.ts`）；展示层隐藏按钮、动作层拒绝直调，双保险
- **安全**：鉴权统一由 `proxy.ts` 中间件完成；`/api` 路由不在中间件匹配范围，需自鉴权（cron 校验 `x-weather-cron-secret` 头）
- **i18n**：文案进 `i18n/messages/{zh,en}.json`；URL 跳转用 `@/i18n/navigation` 的 `Link` / `useRouter`，不手拼前缀
- 生成逻辑代码配**简体中文注释**，提交用 Conventional Commits

## 加新数据源 / 新城市

- **新城市**：管理员在 `/cities` 页表单新增（走 `createCityAction`，经纬度 / 时区经 schema 校验）；或直接向 `cities` 表插一行（name_ja / name_en / latitude / longitude / timezone）
- **新数据源**：在 `lib/weather/providers/` 新增 adapter（实现 `ProviderAdapter` 契约：source / fetchCurrentAndForecast），注册进 `providers` 数组；必要时在 `mapping.ts` 加码映射、在迁移 SQL 的 source check 约束里补新值

# CLAUDE.md

WeatherMind：Next.js 16.2.6（App Router）+ React 19.2.4 + Tailwind 4 + shadcn/ui（@base-ui/react）+ pnpm + TS strict。仅浅色模式。Supabase（认证+PG）、next-intl（zh 无前缀 / en 带 /en）、TanStack Query/Form、Zod、Vitest。

## 命令
`dev`/`build`/`start`；`lint`/`format`/`typecheck`；`test`（Vitest，见 skill `vitest`）；`test:stryker`（Stryker，见 skill `vitest`）

## 目录
- `app/[locale]/` 页面与布局（无 `/api` 路由；外部定时采集直跑 `scripts/weather-cron.ts`）
- `supabase/`：server.ts（会话）/ service.ts（service_role 写入端）/ proxy.ts（中间件鉴权+刷新）/ auth/ / migrations/
- `lib/weather/`：providers/（源 adapter）、http.ts（唯一 fetch）、pipeline.ts（城×源采集）、daily.ts（按城市时区归日）、mapping.ts（condition 归一化）、actions.ts（管理员刷新）、city-actions.ts
- `lib/schemas/` Zod（前后端共用）；`components/`、`hooks/`、`i18n/`；`docs/` 仅供人读，**agent 勿读**
- `.github/workflows/`：ci.yml、stryker.yml（PR 定向变异，结果见日志）、weather-cron.yml（每日采集：Actions 直跑 `scripts/weather-cron.ts` 写库）

## 硬性约定
- 别名 `@/*`；className 用 `cn()`（`@/lib/utils`）
- 提交用 Conventional Commits
- Next.js 16 有破坏性变更，写代码前查 `node_modules/next/dist/docs/`（另见 `AGENTS.md`）
- 逻辑代码配简体中文注释（`rules/comment-style.md`）
- 天气网络请求只走 `lib/weather/http.ts`；新数据源按 `providers/` adapter 契约实现并注册
- Supabase：会话走 server.ts `createClient`；受信写入走 service.ts `createServiceClient`（service_role，**勿在客户端 import**）
- `/api` 不走 proxy 中间件，需自鉴权（当前无 `/api` 路由；如新增 Route Handler 需自带鉴权）

## 规则（`rules/` 常驻，按场景应用）
| 规则 | 适用 |
| --- | --- |
| `rules/comment-style.md` | 写逻辑代码/注释 |
| `rules/fetch-usage.md` | 网络请求 |
| `rules/form-handling.md` | 表单（先调 skill `forms`） |
| `rules/zod-usage.md` | 解析不可信数据 |
| `rules/ui-components.md` | 界面样式 |
| `rules/testing.md` | 评估测试范围（先调 skill `vitest`） |

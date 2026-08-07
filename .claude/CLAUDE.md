# CLAUDE.md

WeatherMind：Next.js 16.2.6（App Router）+ React 19.2.4 + Tailwind CSS 4 + shadcn/ui（基于 @base-ui/react）+ pnpm + TypeScript strict。仅浅色模式（无明暗切换、无 next-themes）。含 Supabase（认证 + Postgres）、next-intl（zh 默认不带前缀，en 带 /en 前缀）、TanStack Query/Form、Zod、Vitest。

## 命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` / `build` / `start` | 开发 / 构建 / 生产运行 |
| `pnpm lint` / `format` / `typecheck` | ESLint / Prettier / 类型检查 |
| `pnpm test` | Vitest 跑测试（见 skill `vitest`） |

## 目录

- `app/[locale]/` — 页面与布局；`app/api/` — Route Handler（cron 等，不走 proxy 中间件）
- `supabase/` — server.ts（会话客户端）/ service.ts（service_role 写入端）/ proxy.ts（中间件鉴权+会话刷新）/ auth/ / migrations/
- `lib/weather/` — 天气管道：providers/*（各源 adapter）、http.ts（唯一 fetch 封装）、pipeline.ts（城×源采集）、daily.ts（按城市时区归日）、mapping.ts（condition 归一化）、actions.ts（管理员手动刷新）、city-actions.ts
- `lib/schemas/` — Zod schema（前后端共用：城市 / 天气 / 认证）
- `components/`、`hooks/`、`i18n/`（next-intl）、`docs/`（快速上手，仅供人读；**agent 不要读**）
- `.github/workflows/` — ci.yml、weather-cron.yml（每日定时采集，触发 `/api/cron/weather`）

## 硬性约定（始终遵守）

- 路径别名 `@/*`；合并 className 用 `cn()`（`@/lib/utils`）
- 提交信息用 Conventional Commits
- Next.js 16 有破坏性变更，写代码前查 `node_modules/next/dist/docs/`（另见 `AGENTS.md`）
- 生成逻辑代码配简体中文注释（规范见 `rules/comment-style.md`）
- 天气网络请求只走 `lib/weather/http.ts`；新增数据源按 `providers/` adapter 契约实现并注册
- Supabase：后端会话走 server.ts `createClient`；受信写入（管道落库、城市增删）走 service.ts `createServiceClient`（service_role，**勿在客户端 import**）
- `/api` 路由不在 proxy 中间件匹配范围，需自鉴权（cron 校验 `x-weather-cron-secret` 头）

## 规则（`rules/` 下全文常驻，按场景应用）

| 规则 | 何时适用 |
| --- | --- |
| `rules/comment-style.md` | 生成或修改逻辑代码、写注释时 |
| `rules/fetch-usage.md` | 涉及网络请求 / 接口调用时 |
| `rules/form-handling.md` | 编写表单、提交、校验流程时（确定要写先调 skill `forms`） |
| `rules/zod-usage.md` | 解析不可信数据（API 响应、env、路由入参）时 |
| `rules/ui-components.md` | 编写或调整界面样式时 |
| `rules/testing.md` | 评估测试范围、避免过度测试时（确定要写先调 skill `vitest`） |

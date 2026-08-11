# CLAUDE.md

WeatherMind：Next 16.2（App Router）+ React 19.2 + Tailwind 4 + shadcn/ui + pnpm + TS strict，浅色。Supabase、next-intl（zh 无前缀 /en 带前缀）、TanStack Query/Form、Zod、Vitest。

命令：`dev/build/start/lint/format/typecheck`；`test/test:stryker` 见 skill `vitest`

目录：
- `app/[locale]/` 页面；定时采集 `scripts/weather-cron.ts`
- `supabase/` server.ts(会话)/service.ts(service_role 写)/proxy.ts(鉴权+刷新)/auth/migrations
- `lib/weather/` providers(源 adapter)/http.ts(唯一 fetch)/pipeline/daily/mapping/actions.ts
- `lib/schemas/` Zod 前后端共用；`components/`、`hooks/`、`i18n/`
- `docs/` 人读，**agent 勿读**；developer-zh/en 改码须同步（见 rules/docs-sync.md）
- `.github/workflows/` ci.yml、stryker.yml(PR 定向变异)、weather-cron.yml(每日采集)

硬性约定：
- 别名 `@/*`；className 用 `cn()`；Conventional Commits
- Next 16 有破坏性变更，写码前查 `node_modules/next/dist/docs/`
- 逻辑代码简体中文注释（rules/comment-style.md）
- 天气请求只走 `lib/weather/http.ts`；新数据源按 providers/adapter 契约注册
- Supabase：会话 `createClient`；受信写 `createServiceClient`（service_role，**勿客户端 import**）
- `/api` 不走 proxy，自带鉴权（照 `app/api/ai-agent/forecast`：`createClient`+`getUser`）

规则（rules/ 按场景加载）：
| 规则 | 适用 |
| --- | --- |
| comment-style | 逻辑代码/注释 |
| fetch-usage | 网络请求 |
| form-handling | 表单（先调 skill `forms`） |
| zod-usage | 解析不可信数据 |
| ui-components | 界面样式 |
| testing | 测试范围（先调 skill `vitest`） |
| docs-sync | 改码后同步 docs/developer-zh.md、developer-en.md |

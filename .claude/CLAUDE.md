# CLAUDE.md

WeatherMind：Next.js 16.2.6（App Router）+ React 19.2.4 + Tailwind CSS 4 + shadcn/ui（基于 @base-ui/react）+ next-themes（`d` 键切明暗，默认跟随系统）+ pnpm + TypeScript strict。**天气功能尚未开发**，`app/page.tsx` 仍是模板页，`lib/`、`hooks/`、`components/` 待展开。

## 命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` / `build` / `start` | 开发 / 构建 / 生产运行 |
| `pnpm lint` / `format` / `typecheck` | ESLint / Prettier / 类型检查 |
| `pnpm test` | Vitest 跑测试（见 skill `vitest`） |

## 目录

- `app/` — 页面与布局；`components/` — 组件（`components/ui/` 为 shadcn 生成）；`hooks/`、`lib/`、`public/`

## 硬性约定（始终遵守）

- 路径别名 `@/*`；合并 className 用 `cn()`（`@/lib/utils`）
- 提交信息用 Conventional Commits
- Next.js 16 有破坏性变更，写代码前查 `node_modules/next/dist/docs/`（另见 `AGENTS.md`）
- 生成逻辑代码配简体中文注释（规范见 `rules/comment-style.md`）

## 规则（`rules/` 下全文常驻，按场景应用）

| 规则 | 何时适用 |
| --- | --- |
| `rules/comment-style.md` | 生成或修改逻辑代码、写注释时 |
| `rules/fetch-usage.md` | 涉及网络请求 / 接口调用时 |
| `rules/form-handling.md` | 编写表单、提交、校验流程时（确定要写先调 skill `forms`） |
| `rules/zod-usage.md` | 解析不可信数据（API 响应、env、路由入参）时 |
| `rules/ui-components.md` | 编写或调整界面样式时 |
| `rules/testing.md` | 评估测试范围、避免过度测试时（确定要写先调 skill `vitest`） |

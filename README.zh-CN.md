# 🌤️ WeatherMind

[English](./README.md) · **简体中文**

WeatherMind 是一个多语言天气智能看板：从多个数据源聚合天气数据、把每日历史存入 Supabase，并在其上构建两个 AI Agent —— **天气预报解读 Agent** 与 **AI 聊天助手**，二者共用一套流式 ReAct（Reasoning + Acting）基建。

---

## ✨ 功能特性

- **多源天气聚合** —— 已接入 Open-Meteo、OpenWeatherMap、WeatherAPI.com，通过统一的 provider adapter 契约；所有请求走同一个 HTTP 封装，所有响应归一化成同一套数据模型。
- **每日历史与回填** —— 定时任务为已跟踪城市采集每日聚合数据；历史用表格与 Recharts 图表展示。
- **确定性预测引擎** —— 集成引擎按权重合并各模型输出、检测数据源间的分歧，并用实际观测数据对预报做真值校验。
- **AI 预报解读** —— 流式 ReAct Agent 阅读集成结果，用通俗语言解释其含义，并给出逐步推理过程。
- **AI 聊天助手** —— 基于 SSE 流式输出的带工具对话 Agent，会话持久化到 Supabase。
- **共享 Agent 基建** —— 一个 `agent-core` 层同时支撑两个 Agent：LLM 对话调用、流式 ReAct 循环、多 Agent 编排，以及 SSRF / DNS 重绑定防护。
- **自带模型** —— 在「设置」中配置任意 OpenAI 兼容的 endpoint + 模型（按账号隔离存于浏览器）。
- **国际化（简体中文 / English）** —— 中文为默认语言无前缀，英文走 `/en`。
- **鉴权与安全** —— Supabase Auth（邮箱密码）、行级安全（RLS），服务端定时写入走独立的 `service_role`。
- **测试保障** —— Vitest 单元/组件/集成测试、Stryker 变异测试、CI 中 Codecov 覆盖率门禁。

## 🛠 技术栈

| 层         | 工具 |
| ---        | --- |
| 框架       | Next.js 16.2（App Router）、React 19.2、TypeScript（strict） |
| 样式       | Tailwind CSS 4、shadcn/ui |
| 数据       | Supabase（Postgres、Auth、RLS）、TanStack Query / Form、Zod（前后端共用 schema） |
| AI         | 任意 OpenAI 兼容 LLM API（endpoint / key / 模型在应用内配置） |
| 国际化     | next-intl（中文默认，英文 `/en` 前缀） |
| 测试       | Vitest、Stryker、Codecov |
| 图表       | Recharts、react-markdown + remark-gfm |
| 工程化     | pnpm、ESLint、Prettier、Conventional Commits |

## 📁 目录结构

```
app/[locale]/            页面 —— 认证（login/register/forgot-password）+ 看板
                        （总览 / 城市 / 预报 / 历史 / 日志 / AI Agent / 设置）
app/api/ai-agent/        服务端路由 —— /forecast、/chat（自带鉴权，不走 proxy）
lib/weather/             数据源适配器（open-meteo / openweather / weatherapi）
                        + 唯一 fetch 封装 + 归一化/聚合 pipeline
lib/agent-core/          共享 AI 基建 —— chat、ReAct 循环、编排、SSRF、DNS
lib/forecast-agent/      预报集成引擎（ensemble/weights/divergence/truth）
                        + 流式 AI 解读
lib/ai-agent/            AI 聊天助手 —— 提示词/工具、会话持久化、SSE
lib/schemas/             前后端共用 Zod schema
lib/model-config.ts      按账号的模型配置（OpenAI 兼容），存于 localStorage
scripts/                 weather-cron.ts —— 定时每日采集
supabase/                server.ts（会话）/ service.ts（service_role 写）
                        / proxy.ts（鉴权 + 刷新）+ migrations/
i18n/                    next-intl 路由 + zh/en 文案
.github/workflows/       ci.yml、stryker.yml、weather-cron.yml
```

## 🚀 快速开始

### 环境要求

- Node.js 20+ 与 pnpm
- 一个 Supabase 项目（或用 [Supabase CLI](https://supabase.com/docs/guides/local-development) 本地开发）
- 天气 API 密钥 —— **Open-Meteo 免费且无需 key**；只有要用 OpenWeatherMap / WeatherAPI.com 时才需申请

### 安装

```bash
pnpm install
```

### 数据库

按顺序把 `supabase/migrations/` 下的 SQL 迁移应用到你的 Supabase 项目，然后将 `.env.example` 复制为 `.env.local` 并填写：

| 变量 | 说明 |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase 项目 URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 公开的 anon key（可暴露给浏览器，受 RLS 约束） |
| `SUPABASE_SERVICE_ROLE_KEY` | 仅服务端使用的 `service_role` key（定时采集 / 管理写），**切勿暴露给浏览器** |
| `OPENWEATHER_API_KEY` | 可选 —— OpenWeatherMap key |
| `WEATHERAPI_API_KEY` | 可选 —— WeatherAPI.com key |

### 启动

```bash
pnpm dev        # 开发服务器
pnpm build      # 生产构建
pnpm start      # 启动生产服务器
```

AI Agent 需要先配置模型 —— 在「设置」页面填写 OpenAI 兼容的 **endpoint + API key + 模型**（按账号存储）。

## 📅 定时采集

`scripts/weather-cron.ts` 为已跟踪城市采集每日天气历史，通过 `weather-cron.yml` GitHub Action 每日运行，用 `SUPABASE_SERVICE_ROLE_KEY` 绕过 RLS 写入。

## 🧪 测试

```bash
pnpm test              # Vitest 单元/组件/集成测试
pnpm test:coverage     # 覆盖率（统计 lib/ + supabase/）
pnpm test:stryker      # Stryker 变异测试
```

- 覆盖率只统计 `lib/**` 与 `supabase/**`；Codecov 门禁 `target:auto` + `threshold:1%`。
- Stryker 在 PR 上对「有测试的」变更文件定向变异（见 `stryker.yml`）。

## 🔧 常用命令

```bash
pnpm lint          # ESLint
pnpm format        # Prettier
pnpm typecheck     # next typegen + tsc --noEmit
```

## 📚 文档

供人阅读：`docs/developer-{zh,en}.md`（模块开发文档）与 `docs/quickstart-{zh,en}.md`（核心链路与代码地图）。

## 🤝 贡献

本项目遵循 [Conventional Commits](https://www.conventionalcommits.org/)。逻辑注释使用简体中文，新代码请与周边风格保持一致。模块约定见 `docs/developer-zh.md`。

## 📄 许可证

私有项目 —— 许可事宜请联系仓库所有者。

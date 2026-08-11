---
name: vitest
description: 写测试前必调——Vitest 单测/组件/集成。范围见 rules/testing.md。
---

# Vitest 测试

统一 Vitest，不用 jest。

## 环境
- 安装：`pnpm add -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event`
- vitest.config.ts：`jsdom`、setupFiles jest-dom、alias `@`→`./`
- `pnpm test`/`test:coverage`/`test:stryker`；测试文件同目录 `*.test.ts(x)`

## 三类测试
- 单测：纯函数/lib。`describe`+`it`+`expect`，不渲染
- 组件：`render`+`screen`+`userEvent`（先 `await user.setup()`）；断言行为不照抄结构，`getByRole` 优先
- 集成：包 `QueryClientProvider`，`vi.mock` 接口，验证取数→渲染→提交链路

## 约定
- `beforeEach` 里 `vi.clearAllMocks()`；异步用 `await screen.findBy*`，不用 `waitFor`
- mock 用 `vi.mock()`+`vi.fn()`；内部可信不测；提交前跑 `pnpm test`

## 覆盖率（Codecov）
回归门禁不刷数字：`pnpm test:coverage` 看 `text`+`./coverage/lcov.info`
只统计 `lib/**`、`supabase/**`；CI codecov-action@v5 OIDC 免 token；门禁 `target:auto`+`threshold:1%`
改 lib 逻辑提交前本地跑，确保新行有断言；覆盖率≠有效性

## 变异（Stryker）
- `pnpm test:stryker`；config 见 `stryker.config.json`（白名单：只变异「有测试」的源文件）
- 定向：`pnpm test:stryker --mutate "lib/weather/pipeline.ts"`
- **break 80%** 低于即失败；CI PR 定向变异「有测试」的变更文件，结果看 Actions 日志（stryker.yml）
- Survived＝没断言兜住，补断言/拆用例，**别删断言降标准**

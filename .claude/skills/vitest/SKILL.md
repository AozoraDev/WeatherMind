---
name: vitest
description: 写测试前必调——Vitest 单测/组件/集成。范围见 rules/testing.md。
---

# Vitest 测试

统一 Vitest，覆盖单测/组件/集成，不用 jest。

## 环境
- 安装：`pnpm add -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event`
- `vitest.config.ts`：`environment:'jsdom'`、`setupFiles` 引 jest-dom、`alias '@'→'./'`
- 命令 `pnpm test`（run）/ `test:coverage` / `test:stryker`（stryker）；测试文件与源码同目录，`*.test.ts(x)`

## 三类测试
- 单测：纯函数/lib。`describe`+`it`+`expect`，不渲染
- 组件：`render`+`screen`+`userEvent`（先 `await user.setup()`）。断言行为不照抄结构，`getByRole` 优先
- 集成：包 `QueryClientProvider`，`vi.mock` 接口，验证取数→渲染→提交链路

## 约定
- `beforeEach` 里 `vi.clearAllMocks()`
- 异步用 `await screen.findBy*`，不用 `waitFor`
- mock 用 `vi.mock()`+`vi.fn()`
- 内部可信数据不测；验证行为与边界
- 提交前跑 `pnpm test`

## 覆盖率（Codecov）
回归门禁，不刷数字。
- `pnpm test:coverage` 看报告：`text` + `./coverage/lcov.info`（上传用）
- 只统计 `lib/**`、`supabase/**`，UI/模板不计入
- CI 用 codecov-action@v5 上传，OIDC 无需 token；门禁 `target:auto`+`threshold:1%`
- 改 lib 逻辑提交前本地跑，确保新行有断言
- 覆盖率 ≠ 有效性，看变异

## 变异（Stryker）
验证测试有效性，不堆覆盖率。
- `pnpm test:stryker`；config 见 `stryker.config.json`（白名单：只变异「有测试」的源文件）
- 定向：`pnpm test:stryker --mutate "lib/weather/pipeline.ts"`
- **break 阈值 80%**：低于即失败
- CI：PR 触发必跑、从不跳过——有「有测试」的变更源文件则定向变异，否则回退全量白名单，并评论英文报告（stryker.yml）
- Survived＝没断言兜住，补断言或拆用例，**别删断言降标准**

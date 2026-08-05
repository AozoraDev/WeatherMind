---
name: vitest
description: 写测试前必调——统一用 Vitest 写单测/组件/集成测试。范围见 rules/testing.md。
---

# Vitest 测试

统一 **Vitest**，一个栈覆盖单测 / 组件测试 / 集成测试，不用 jest。

## 环境

- 安装：`pnpm add -D vitest @vitejs/plugin-react jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event`
- `vitest.config.ts`：`environment: 'jsdom'`；`setupFiles` 引入 `@testing-library/jest-dom`；`resolve.alias` 配 `'@' → './'`
- 命令 `pnpm test`（`vitest run`），package.json 加 `"test": "vitest run"`；测试文件与源码同目录，命名 `*.test.ts(x)`

## 三类测试

- **单测**：纯函数 / lib 工具。`describe` + `it` + `expect`，不渲染。如换算、格式化、schema `safeParse`
- **组件测试**：`render` + `screen` 查询 + `userEvent` 交互（先 `await user.setup()`）。断言行为不照抄结构；优先 `getByRole`，少用 `data-testid`
- **集成测试**：组件树包 `QueryClientProvider`，`vi.mock` 接口，验证取数 → 渲染 → 提交链路

## 约定

- `beforeEach` 里 `vi.clearAllMocks()`
- 异步用 `await screen.findBy*`，不用 `waitFor` 轮询
- mock 用 `vi.mock()` + `vi.fn()`
- 内部可信数据不测；验证行为与边界，不追覆盖率
- 提交前跑 `pnpm test`，失败先修测试

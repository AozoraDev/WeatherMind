# 测试范围

只测有实际价值的，不过度。要写先调 skill `vitest`。
- **需测**：复杂纯函数（换算/日期/状态推导）、Zod 边界（缺失/漂移/非法）、fetch 封装（res.ok/兜底/断网）、跨模块集成（取数→渲染→提交）
- **不测**：纯展示组件、shadcn 模板、内部可信数据、一行 if、一次性代码
- 覆盖关键分支与边界，不追 100%

## 覆盖率（Codecov，回归门禁非目标）
`pnpm test:coverage`，config 见 `codecov.yml`
- 只统计 `lib/**`、`supabase/**`（vitest.config.ts include），UI 不计入
- CI 跑 test:coverage 后 codecov-action@v5 上传，OIDC 免 token
- 门禁 `target:auto`+`threshold:1%`：PR 不得低于基准 1% 以上，否则失败
- 覆盖率 ≠ 有效性，看变异

## 变异测试（Stryker）
验证测试有效性：`pnpm test:stryker`，config 见 `stryker.config.json`，用法见 skill `vitest`
- 只变异「有测试」的源文件（mutate 含 `supabase/auth/errors.ts`），无测试的不变异
- PR 定向变异变更文件中「有测试」的（磁盘存在同名 `.test.ts` 才纳入），结果看 Actions 日志（stryker.yml）
- 新增源文件测试后，把源文件加进 mutate 白名单，否则本地全量不变异它
- **break 80%**：低于则 CI 失败。Survived=没断言兜住，补断言或拆用例，**别删断言降标准**

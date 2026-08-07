# 测试范围

只测有实际价值的，不过度测试。确定要写，先调 skill `vitest`。

**需测**：复杂纯函数（天气换算/日期格式化/状态推导）、Zod 校验边界（缺失/漂移/非法）、fetch 封装（`res.ok` 分支/兜底/断网）、跨模块集成链路（取数→渲染→提交）。
**不测**：纯展示组件、shadcn 模板、内部可信数据、一行 if 可表达、一次性代码。
原则：覆盖关键分支与边界即可，不追 100%。

## 覆盖率（Codecov）

CI 采集上报，是**回归门禁**而非目标：`pnpm test:coverage`，config 见 `codecov.yml`。

- 只统计 `lib/**`、`supabase/**`（vitest.config.ts include），UI/模板不计入
- CI test job 跑 `test:coverage` 后 codecov-action@v5 上传，OIDC 无需 token（ci.yml）
- 门禁 `target:auto` + `threshold:1%`：PR 不得低于基准 1% 以上，否则失败；评论展示 diff 覆盖
- 覆盖率 ≠ 测试有效，有效性看变异测试

## 变异测试（Stryker）

验证测试**有效性**：`pnpm test:stryker`，config 见 `stryker.config.json`，用法见 skill `vitest`。

- **白名单策略**：只变异「有测试」的源文件（见 `stryker.config.json` mutate，含 `supabase/auth/errors.ts`），无测试的不变异（避免 NoCoverage 拖垮门禁）
- PR 触发，定向变异变更文件中「有测试」的（磁盘上存在同名 `.test.ts` 才纳入），结果在 Actions 日志中查看（stryker.yml）
- 新增源文件测试后，把源文件加进 `stryker.config.json` 的 mutate 白名单，否则本地全量跑不变异它
- **break 阈值 80%**：低于则 CI 失败。Survived＝该行为没断言兜住，补断言或拆用例，**别删断言降标准**

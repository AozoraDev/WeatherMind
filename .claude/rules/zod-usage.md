# Zod 使用时机

Zod 用于**信任边界**运行时校验：数据从不可信来源进入、TS 静态保证不了的地方；内部可信数据不重复校验。

适用：外部 API 响应、环境变量、路由参数 / 查询串、表单（见 `form-handling.md`）、远端配置、类型推导。
不适用：内部可信对象、单字段 if 可表达的约束、热路径（循环内高频调用避免每次 `.parse()`）。

- 优先 `safeParse`；`.parse()` 仅「失败即抛错、无需恢复」场合
- 类型单一来源：用 `z.infer<typeof schema>` 推导，禁止 schema / interface / 手写校验并存
- 一份 schema 前后端共用，集中 `lib/schemas/` 或 `lib/validations/`
- 未安装时 `pnpm add zod`，不绕过、不用 `any` 凑合

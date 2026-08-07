# Zod 使用时机

Zod 用于**信任边界**运行时校验：不可信来源、TS 静态保证不了处；内部可信数据不校验。

- 适用：外部 API 响应、env、路由参数/查询串、表单（见 form-handling.md）、远端配置
- 不适用：内部可信对象、单字段 if 即可、热路径（循环内高频勿每次 `.parse()`）
- 优先 `safeParse`；`.parse()` 仅「失败即抛错、无需恢复」
- 类型单一来源：用 `z.infer` 推导，禁止 schema/interface/手写校验并存
- 一份 schema 前后端共用，集中 `lib/schemas/`
- 未安装 `pnpm add zod`，不绕过、不用 `any`

---
name: forms
description: 写表单前必调——统一用 TanStack Query + TanStack Form + Zod 写表单。范围见 rules/form-handling.md。
---

# 表单（TanStack Query + Form + Zod）

不手写 `useState` 表单状态、不手写校验逻辑。

## 环境

- 安装：`pnpm add @tanstack/react-query @tanstack/react-form zod`
- `app/layout.tsx` 根部包 `QueryClientProvider`（useQuery / useMutation 必需）

## 接线

- 一份 Zod schema 前后端共用，放 `lib/schemas/`；类型用 `z.infer` 推导，不另写 interface
- schema 传给 `useForm` 的 `validators`，由表单触发校验，不手写 if/else
- 提交：`onSubmit` 调 `useMutation`，用 `isPending` / `isError` 控制按钮与错误提示
- 回填：`useQuery` 的 data 映射 `defaultValues`，未就绪用 `isLoading` 兜底

## 关联

- 请求封装见 rules/fetch-usage.md；Zod 时机见 rules/zod-usage.md

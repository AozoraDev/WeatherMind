---
name: forms
description: 写表单前必调——TanStack Query + TanStack Form + Zod。范围见 rules/form-handling.md。
---

# 表单（Query + Form + Zod）

不手写 `useState` 表单状态、不手写校验逻辑。

## 环境
- 安装：`pnpm add @tanstack/react-query @tanstack/react-form zod`
- 根部包 `QueryClientProvider`（useQuery/useMutation 必需）

## 接线
- 一份 schema 前后端共用，放 `lib/schemas/`；类型 `z.infer` 推导，不另写 interface
- schema 传 `useForm` 的 `validators`，由表单校验，不手写 if/else
- 提交：`onSubmit` 调 `useMutation`，`isPending`/`isError` 控按钮与提示
- 回填：`useQuery` data 映射 `defaultValues`，`isLoading` 兜底

## 关联
- 请求见 rules/fetch-usage.md；Zod 时机见 rules/zod-usage.md

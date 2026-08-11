# 网络请求（fetch）

统一原生 fetch，封装一套，不引 axios/ky
- 先判 `res.ok`，非 2xx 走错误分支（直接 `res.json()` 会抛错）
- `try/catch` 包裹，断网给默认值或错误提示
- 外部响应先 Zod `safeParse`（见 zod-usage.md），防字段缺失/类型漂移
- 客户端不裸 fetch：封装进 TanStack Query `queryFn`
- 服务端按接口设 `cache`/`next:{revalidate,tags}` 避免重复请求

避免：axios、跳过 `res.ok` 直接 `res.json()`、组件手写 useState+fetch+loading

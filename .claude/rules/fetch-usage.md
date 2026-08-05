# 网络请求（fetch）

网络请求统一用 Web API 原生 `fetch`，不引入 axios / ky 等第三方 HTTP 库，请求封装只做一套。

- 先判断 `res.ok`，非 2xx 走错误分支（直接 `res.json()` 可能抛错）
- `try/catch` 包裹，断网等网络错误给默认值或错误提示
- 外部响应先 Zod `safeParse`（见 `zod-usage.md`），防字段缺失、类型漂移
- 客户端取数不裸 fetch：封装进 TanStack Query 的 `queryFn`（见 `form-handling.md`）
- 服务端按接口性质设 `cache` / `next: { revalidate, tags }`，避免重复请求

**避免**：引入 axios、跳过 `res.ok` 直接 `res.json()`、组件里手写 `useState` + `fetch` + loading。

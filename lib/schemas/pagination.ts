import { z } from "zod"

// 分页查询参数：?page=，服务端 RSC 读取 searchParams 后经此校验归一。
// 页长固定每页 20 条（不随 URL 变化），翻页只改页码。
// 该文件为纯前后端共用（无服务端依赖），客户端可安全 import 常量与纯函数。

export const DEFAULT_PAGE_SIZE = 20

// searchParams 值为 string | string[] | undefined；z.coerce.number 把字符串转数字，
// 空串/非法值转 NaN 后不满足 int.min，导致整个对象校验失败回退默认
export const paginationParamsSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
})
export type PaginationParams = z.infer<typeof paginationParamsSchema>

// 解析 searchParams：合法返回归一结果（page 恒有值），非法回退默认
export function parsePagination(
  params: Record<string, unknown>
): PaginationParams {
  const result = paginationParamsSchema.safeParse(params)
  return result.success ? result.data : { page: 1 }
}

// 由总数与每页条数计算总页数，至少 1 页（空数据也不出现第 0 页）
export function totalPages(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize))
}

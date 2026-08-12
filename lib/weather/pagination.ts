import { totalPages } from "@/lib/schemas/pagination"

// 分页元数据：供前端分页条渲染（页码/每页条数/总数/总页数）
export type PageMeta = {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

// 分页结果：rows 为当前页数据，meta 同 PageMeta
export type PageResult<T> = PageMeta & {
  rows: T[]
}

// 只依赖 range 的结构化类型：项目无生成 DB 类型，createClient 返回 untyped builder，
// 其 range 返回 PromiseLike<unknown>；不引 Postgrest 泛型类型，避免因泛型字面量差异写死 any
type RangeableQuery = {
  range: (from: number, to: number) => PromiseLike<unknown>
}

// 对已配置好 select("*", { count: "exact" }) 与 order 的查询追加 range，返回该页数据与匹配总数；
// 过滤条件（eq/gte 等）由调用方在传入前附加。count 为整表匹配数（不含 range），totalPages 由它推导。
export async function fetchPage<T>(
  query: RangeableQuery,
  page: number,
  pageSize: number
): Promise<PageResult<T>> {
  const from = (page - 1) * pageSize
  // Supabase builder await 后为 { data, count, error, ... }，这里只解构用到的三个字段
  const { data, count, error } = (await query.range(
    from,
    from + pageSize - 1
  )) as {
    data: T[] | null
    count: number | null
    error: { message: string } | null
  }
  if (error) throw error
  const rows = data ?? []
  const total = count ?? rows.length
  return {
    rows,
    page,
    pageSize,
    total,
    totalPages: totalPages(total, pageSize),
  }
}

import { describe, expect, it } from "vitest"

import { fetchPage } from "./pagination"

// 桩 query：只实现 range，捕获端点供断言；data/count/error 可注入
function stubQuery(
  data: unknown[],
  count: number | null,
  error: unknown = null
) {
  const calls: [number, number][] = []
  const query = {
    range: (from: number, to: number) => {
      calls.push([from, to])
      return Promise.resolve({ data, count, error })
    },
  }
  return { query, calls }
}

describe("fetchPage", () => {
  it("按 page/pageSize 计算 range 端点并返回页数据与总数", async () => {
    const rows = [{ id: 1 }, { id: 2 }]
    const { query, calls } = stubQuery(rows, 25)
    const res = await fetchPage<{ id: number }>(query, 2, 10)

    // page 2 页长 10 → 偏移 [10, 19]（含端）
    expect(calls).toEqual([[10, 19]])
    expect(res).toEqual({
      rows,
      page: 2,
      pageSize: 10,
      total: 25,
      totalPages: 3,
    })
  })

  it("count 缺失时用行数兜底", async () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }]
    const { query } = stubQuery(rows, null)
    const res = await fetchPage<{ id: number }>(query, 1, 10)
    expect(res.total).toBe(3)
    expect(res.totalPages).toBe(1)
  })

  it("data 为 null（Supabase 空返回）→ 行集为空数组，总数取 count", async () => {
    const { query } = stubQuery(null as unknown as unknown[], 25)
    const res = await fetchPage<{ id: number }>(query, 1, 10)
    expect(res.rows).toEqual([])
    expect(res.total).toBe(25)
    expect(res.totalPages).toBe(3)
  })

  it("range 报错时抛出", async () => {
    const { query } = stubQuery([], null, { message: "boom" })
    await expect(fetchPage(query, 1, 10)).rejects.toThrow("boom")
  })
})

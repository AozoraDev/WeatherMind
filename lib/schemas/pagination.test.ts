import { describe, expect, it } from "vitest"

import { parsePagination, totalPages } from "./pagination"

describe("parsePagination", () => {
  it("缺省参数回退默认值", () => {
    expect(parsePagination({})).toEqual({ page: 1 })
  })

  it("合法字符串参数归一为数字", () => {
    expect(parsePagination({ page: "2" })).toEqual({ page: 2 })
  })

  it("page 为 0 非法，整体回退默认", () => {
    expect(parsePagination({ page: "0" })).toEqual({ page: 1 })
  })

  it("page 为非整数非法，整体回退默认", () => {
    expect(parsePagination({ page: "3.5" })).toEqual({ page: 1 })
  })

  it("page 为非数字非法，整体回退默认", () => {
    expect(parsePagination({ page: "abc" })).toEqual({ page: 1 })
  })

  it("值为数组非法，整体回退默认", () => {
    expect(parsePagination({ page: ["1"] })).toEqual({ page: 1 })
  })

  it("多余参数忽略（页长已固定，pageSize 不再参与）", () => {
    expect(parsePagination({ page: "3", pageSize: "50" })).toEqual({ page: 3 })
  })
})

describe("totalPages", () => {
  it("空数据至少 1 页", () => {
    expect(totalPages(0, 20)).toBe(1)
  })

  it("整除时页数为总数除以页长", () => {
    expect(totalPages(40, 20)).toBe(2)
  })

  it("不整除时向上取整", () => {
    expect(totalPages(41, 20)).toBe(3)
  })

  it("恰好一页为 1", () => {
    expect(totalPages(20, 20)).toBe(1)
  })
})

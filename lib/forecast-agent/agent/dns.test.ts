import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }))

import { lookup } from "node:dns/promises"

import { resolveHostAll } from "./dns"

// DNS 解析唯一入口：把 node:dns/promises 隔离在小模块，供 provider 做 SSRF 复核
beforeEach(() => {
  vi.mocked(lookup).mockReset()
})

afterEach(() => {
  vi.resetModules()
})

describe("resolveHostAll", () => {
  it("调用 lookup(host, { all: true }) 返回全部地址记录", async () => {
    const addresses = [
      { address: "1.2.3.4", family: 4 },
      { address: "5.6.7.8", family: 4 },
    ]
    // lookup 有多重载（all:true 返回数组、默认单条），mockResolvedValue 类型只匹配单条重载，强转绕过
    vi.mocked(lookup).mockResolvedValue(addresses as never)

    await expect(resolveHostAll("api.example.com")).resolves.toEqual(addresses)
    expect(lookup).toHaveBeenCalledWith("api.example.com", { all: true })
  })

  it("解析失败向调用方透传错误（不吞，由 provider 上层兜底）", async () => {
    vi.mocked(lookup).mockRejectedValue(new Error("ENOTFOUND"))
    await expect(resolveHostAll("no-such-host")).rejects.toThrow("ENOTFOUND")
  })
})

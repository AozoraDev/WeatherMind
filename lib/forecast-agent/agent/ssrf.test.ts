import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveHostAll } from "./dns"
import { hostResolvesToPublic, isAllowedBaseUrl, isPrivateHost } from "./ssrf"

vi.mock("./dns", () => ({ resolveHostAll: vi.fn() }))

const mockedResolve = vi.mocked(resolveHostAll)

describe("isPrivateHost", () => {
  it("回环与 localhost 拦截", () => {
    expect(isPrivateHost("localhost")).toBe(true)
    expect(isPrivateHost("127.0.0.1")).toBe(true)
    expect(isPrivateHost("127.5.5.5")).toBe(true)
    expect(isPrivateHost("::1")).toBe(true)
  })

  it("私有网段拦截", () => {
    expect(isPrivateHost("10.0.0.1")).toBe(true)
    expect(isPrivateHost("172.16.0.1")).toBe(true)
    expect(isPrivateHost("172.31.255.255")).toBe(true)
    expect(isPrivateHost("192.168.1.1")).toBe(true)
    expect(isPrivateHost("169.254.169.254")).toBe(true) // 元数据端点
  })

  it("公网 IP 放行", () => {
    expect(isPrivateHost("8.8.8.8")).toBe(false)
    expect(isPrivateHost("172.32.0.1")).toBe(false) // 172.32 不在 172.16/12
  })

  it("内网保留域名拦截", () => {
    expect(isPrivateHost("foo.local")).toBe(true)
    expect(isPrivateHost("service.internal")).toBe(true)
  })

  it("大小写不敏感与首尾空白兜底", () => {
    expect(isPrivateHost("LOCALHOST")).toBe(true)
    expect(isPrivateHost("LocalHost")).toBe(true)
    expect(isPrivateHost("  localhost  ")).toBe(true)
  })

  it(".localhost 后缀拦截", () => {
    expect(isPrivateHost("x.localhost")).toBe(true)
    expect(isPrivateHost("foo.localhost")).toBe(true)
  })

  it("普通域名放行", () => {
    expect(isPrivateHost("api.openai.com")).toBe(false)
    expect(isPrivateHost("localexample.com")).toBe(false) // 非 .local 后缀
  })

  it("IPv4 字面量锚点：多余字符不算 IPv4", () => {
    // 前后有非数字字符时不应被当作 IPv4 字面量
    expect(isPrivateHost("10.0.0.1foo")).toBe(false)
    expect(isPrivateHost("foo.10.0.0.1")).toBe(false)
  })

  it("IPv4 非法段（>255）按私网拦截，边界 255 放行", () => {
    expect(isPrivateHost("999.1.1.1")).toBe(true)
    expect(isPrivateHost("1.2.3.400")).toBe(true)
    expect(isPrivateHost("255.1.1.1")).toBe(false)
  })

  it("IPv4 私有段边界全覆盖", () => {
    expect(isPrivateHost("0.1.2.3")).toBe(true) // 0/8
    expect(isPrivateHost("0.0.0.0")).toBe(true)
    expect(isPrivateHost("172.15.0.1")).toBe(false) // 172.16/12 下限之外
    expect(isPrivateHost("8.20.0.1")).toBe(false)
    expect(isPrivateHost("169.255.1.1")).toBe(false) // 169.254/16 之外
    expect(isPrivateHost("192.169.1.1")).toBe(false) // 192.168/16 之外
    expect(isPrivateHost("1.254.1.1")).toBe(false) // 非 169 段但第二段为 254
    expect(isPrivateHost("1.168.1.1")).toBe(false) // 非 192 段但第二段为 168
  })

  it("IPv6 回环/链路本地/ULA 全拦", () => {
    expect(isPrivateHost("::")).toBe(true)
    expect(isPrivateHost("fe80::1")).toBe(true)
    expect(isPrivateHost("fe90::1")).toBe(true)
    expect(isPrivateHost("fea0::1")).toBe(true)
    expect(isPrivateHost("feb0::1")).toBe(true)
    expect(isPrivateHost("fc00::1")).toBe(true)
    expect(isPrivateHost("fd00::1")).toBe(true)
  })

  it("IPv6 公网放行；无冒号不进入 IPv6 分支", () => {
    expect(isPrivateHost("2001:4860:4860::8888")).toBe(false)
    expect(isPrivateHost("2606:4700:4700::1111")).toBe(false)
    expect(isPrivateHost("fe80")).toBe(false) // 无冒号，仅命中 startsWith 不算 IPv6
  })

  it("IPv6 保留段（::/8）拦截", () => {
    // ::/8 属 IANA 保留段（含回环/未指定/兼容地址），全拦
    expect(isPrivateHost("1:2:3:4:5:6:7:8")).toBe(true)
  })

  it("IPv6 内嵌 IPv4（映射/兼容/6to4）还原判私网", () => {
    expect(isPrivateHost("[::1]")).toBe(true) // 带方括号字面量
    expect(isPrivateHost("::ffff:127.0.0.1")).toBe(true)
    expect(isPrivateHost("[::ffff:7f00:1]")).toBe(true) // Node 规范后的映射回环
    expect(isPrivateHost("::ffff:7f00:1")).toBe(true)
    expect(isPrivateHost("2002:7f00:1::")).toBe(true) // 6to4 内嵌 127.0.0.1
    expect(isPrivateHost("::ffff:8.8.8.8")).toBe(false) // 映射公网放行
    expect(isPrivateHost("2002:0808:0808::")).toBe(false) // 6to4 内嵌 8.8.8.8
  })

  it("IPv6 文档/保留前缀拦截", () => {
    expect(isPrivateHost("2001:db8::1")).toBe(true) // 文档段
    expect(isPrivateHost("64:ff9b::102:304")).toBe(true) // NAT64
    expect(isPrivateHost("ff02::1")).toBe(true) // 多播
  })
})

describe("isAllowedBaseUrl", () => {
  it("https + 公网域名放行", () => {
    expect(isAllowedBaseUrl("https://api.openai.com/v1")).toBe(true)
  })

  it("非 https 拒绝", () => {
    expect(isAllowedBaseUrl("http://api.openai.com/v1")).toBe(false)
    expect(isAllowedBaseUrl("ftp://api.openai.com/v1")).toBe(false)
  })

  it("私网/本地 URL 拒绝", () => {
    expect(isAllowedBaseUrl("https://localhost:11434")).toBe(false)
    expect(isAllowedBaseUrl("https://192.168.1.10/v1")).toBe(false)
    expect(isAllowedBaseUrl("https://10.0.0.5/v1")).toBe(false)
    // IPv6 回环映射：URL 会规范成 [::ffff:7f00:1] 十六进制形式
    expect(isAllowedBaseUrl("https://[::ffff:127.0.0.1]:8080")).toBe(false)
    expect(isAllowedBaseUrl("https://[::ffff:7f00:1]:8080")).toBe(false)
    expect(isAllowedBaseUrl("https://[::1]/v1")).toBe(false)
  })

  it("非法 URL 拒绝", () => {
    expect(isAllowedBaseUrl("not a url")).toBe(false)
  })

  it("URL 带路径/尾斜杠/端口均正常解析", () => {
    expect(isAllowedBaseUrl("https://api.openai.com/v1/")).toBe(true)
    expect(isAllowedBaseUrl("https://api.openai.com")).toBe(true)
    expect(isAllowedBaseUrl("https://8.8.8.8:443/v1")).toBe(true) // 公网 IP 带端口
  })
})

describe("hostResolvesToPublic", () => {
  afterEach(() => mockedResolve.mockReset())

  it("全部解析为公网 IP 通过", async () => {
    mockedResolve.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::", family: 6 },
    ])
    await expect(hostResolvesToPublic("example.com")).resolves.toBe(true)
  })

  it("任一解析为内网 IP 拒绝", async () => {
    mockedResolve.mockResolvedValue([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ])
    await expect(hostResolvesToPublic("example.com")).resolves.toBe(false)
  })

  it("解析失败拒绝", async () => {
    mockedResolve.mockRejectedValue(new Error("ENOTFOUND"))
    await expect(hostResolvesToPublic("no-such-host.invalid")).resolves.toBe(
      false
    )
  })

  it("host 本身就是私网直接拒绝，不触发 DNS", async () => {
    // 即使 mock 返回公网记录，字面量命中私网也应直接拦截且不发起解析
    mockedResolve.mockResolvedValue([{ address: "8.8.8.8", family: 4 }])
    await expect(hostResolvesToPublic("10.0.0.1")).resolves.toBe(false)
    expect(mockedResolve).not.toHaveBeenCalled()
  })
})

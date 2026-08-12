import { isIP } from "node:net"

import { resolveHostAll } from "./dns"

// SSRF 防护（OpenAI 兼容 chat 调用前）：仅 https + host 白名单（禁私网/保留地址），
// 再对解析出的全部 IP 复核，防「公共域名解析到内网」的绕过

// —— SSRF host 白名单 ——
// 判断 host 是否命中私网/保留地址（本地字面量 + 特殊段），命中即拒绝。
// IPv6 注意：URL.hostname 把 IPv4 映射地址规范为带括号的 [::ffff:7f00:1]，
// 必须剥括号、还原内嵌 IPv4 后再复用同一套私网判断，否则回环映射可绕过。

// IPv4 私网判断（IPv4 字面量与 IPv6 内嵌 IPv4 共用）；非法段一律按私网拦
function isPrivateIpv4(h: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return true
  const parts = m.slice(1).map(Number)
  if (parts.some((n) => Number.isNaN(n) || n > 255)) return true
  const [a, b] = parts
  return (
    a === 10 || // 10/8
    a === 127 || // 回环 127/8
    a === 0 || // 本网络 0/8
    (a === 169 && b === 254) || // link-local 169.254/16
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) // 192.168/16
  )
}

// 解析 IPv6 为 8 组 16 位数值；支持 :: 压缩与尾部 IPv4 点分写法；非法返回 null
function parseIpv6Groups(addr: string): number[] | null {
  let a = addr.trim().toLowerCase()
  // 尾部 IPv4 写法（::ffff:127.0.0.1）→ 换算成两个 16 位组
  const v4Tail = /^(.+):(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(a)
  if (v4Tail) {
    const parts = v4Tail[2].split(".").map(Number)
    if (parts.some((n) => Number.isNaN(n) || n > 255)) return null
    a = `${v4Tail[1]}:${(parts[0] << 8) | parts[1]}:${(parts[2] << 8) | parts[3]}`
  }
  let groups: number[] = []
  const dc = a.indexOf("::")
  if (dc !== -1) {
    const left = a.slice(0, dc)
    const right = a.slice(dc + 2)
    const l = left ? left.split(":").map((g) => parseInt(g, 16)) : []
    const r = right ? right.split(":").map((g) => parseInt(g, 16)) : []
    const missing = 8 - l.length - r.length
    if (missing < 1) return null // 单 :: 至少展开一位
    groups = [...l, ...Array<number>(missing).fill(0), ...r]
  } else {
    groups = a.split(":").map((g) => parseInt(g, 16))
  }
  if (groups.length !== 8) return null
  if (groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null
  return groups
}

// 取 IPv6 内嵌的 IPv4（IPv4 映射/兼容 ::ffff:a.b.c.d 与 6to4 2002:xxxx:xxxx::）
function embeddedIpv4(groups: number[]): string | null {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    (g5 === 0 || g5 === 0xffff)
  ) {
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`
  }
  if (g0 === 0x2002) return `${g1 >> 8}.${g1 & 0xff}.${g2 >> 8}.${g2 & 0xff}` // 6to4
  return null
}

// IPv6 保留/私网段前缀判断（无内嵌 IPv4 的纯 IPv6）
function isPrivateIpv6(groups: number[]): boolean {
  const [g0, g1] = groups
  if (g0 < 0x100) return true // ::/8：未指定/回环/兼容等保留段
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 链路本地
  if ((g0 & 0xff00) === 0xff00) return true // ff00::/8 多播
  if (g0 === 0x0064 && g1 === 0xff9b) return true // 64:ff9b::/96 NAT64
  if (g0 === 0x0100) return true // 100::/64 discard-only
  if (g0 === 0x2001 && g1 === 0x0db8) return true // 2001:db8::/32 文档
  if (g0 === 0x2001 && (g1 & 0xfff0) === 0x0010) return true // 2001:10::/28 ORCHID
  return false // 其余 IPv6 视为公网放行
}

export function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  if (h === "localhost" || h.endsWith(".localhost")) return true
  // 内网保留 TLD：mdns / 内网域名
  if (h.endsWith(".local") || h.endsWith(".internal")) return true

  // IPv4 字面量：按段位私网判断
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) return isPrivateIpv4(h)

  // IPv6 字面量（URL.hostname 带方括号）：剥括号 → 解析 → 内嵌 IPv4 / 段前缀判断
  const v6 = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h
  if (isIP(v6) === 6) {
    const groups = parseIpv6Groups(v6)
    if (!groups) return true // 解析失败按私网拦
    const mapped = embeddedIpv4(groups)
    if (mapped) return isPrivateIpv4(mapped)
    return isPrivateIpv6(groups)
  }

  return false // 普通域名先放行，交给 DNS 复核
}

// 静态校验 baseUrl：仅 https + host 不在私网/保留名单
export function isAllowedBaseUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false // 非法 URL 直接拒绝
  }
  if (u.protocol !== "https:") return false
  return !isPrivateHost(u.hostname)
}

// DNS 复核：解析出的全部 A/AAAA 记录都必须是公网地址；解析失败按不通过
export async function hostResolvesToPublic(host: string): Promise<boolean> {
  if (isPrivateHost(host)) return false
  try {
    const records = await resolveHostAll(host)
    return records.every((r) => !isPrivateHost(r.address))
  } catch {
    return false
  }
}

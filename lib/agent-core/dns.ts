import type { LookupAddress } from "node:dns"
import { lookup } from "node:dns/promises"

// DNS 解析的唯一入口：把 node:dns/promises 隔离在这个小模块，
// 测试通过 vi.mock("./dns") 替换（node: 内置模块无法在 import 链上可靠 mock）。
// 只导出 host 的全部 A/AAAA 记录，供 provider 做 SSRF 复核。
export function resolveHostAll(host: string): Promise<LookupAddress[]> {
  return lookup(host, { all: true })
}

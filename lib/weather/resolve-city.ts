import { getLocale } from "next-intl/server"

import { redirect } from "@/i18n/navigation"
import type { CityRow } from "./view-types"

// 解析 ?city= 参数为唯一城市：name_en 不区分大小写匹配，回退东京，再退第一个；
// 参数缺失或无效时重定向到规范 URL，让地址栏 ?city= 始终与选中城市一致
export async function resolveCityParam(
  cities: CityRow[],
  rawCity: string | undefined,
  pathname: string
): Promise<CityRow | null> {
  if (cities.length === 0) return null

  const selected =
    cities.find(
      (c) => c.name_en.toLowerCase() === (rawCity ?? "").toLowerCase()
    ) ??
    cities.find((c) => c.name_en.toLowerCase() === "tokyo") ??
    cities[0]

  // 参数与解析结果不一致（缺失或无效）时补齐重定向，随后页面即按规范参数取单城数据
  if (selected.name_en.toLowerCase() !== (rawCity ?? "").toLowerCase()) {
    redirect({
      href: { pathname, query: { city: selected.name_en } },
      locale: await getLocale(),
    })
  }

  return selected
}

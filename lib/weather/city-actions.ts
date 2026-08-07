"use server"

import {
  createCitySchema,
  deleteCitySchema,
  type CreateCityValues,
  type DeleteCityValues,
} from "@/lib/schemas/city"
import { createClient } from "@/supabase/server"
import { createServiceClient } from "@/supabase/service"

import { isAdminEmail } from "./admin"
import type { CityErrorCode } from "./errors"

export type CityActionResult =
  { ok: true } | { ok: false; error: CityErrorCode }

// 管理员门禁：读会话 → 白名单校验；不通过返回 false，防绕过 UI 直调动作
async function requireAdmin(): Promise<boolean> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return Boolean(user && isAdminEmail(user.email))
}

// 新增城市：schema 先验 → 管理员门禁 → service 客户端写入（绕过 RLS）；
// name_en 唯一冲突（Postgres 23505）映射为 duplicate
export async function createCityAction(
  values: CreateCityValues
): Promise<CityActionResult> {
  const parsed = createCitySchema.safeParse(values)
  if (!parsed.success) return { ok: false, error: "invalidInput" }
  if (!(await requireAdmin())) return { ok: false, error: "unauthorized" }

  const { nameJa, nameEn, latitude, longitude, timezone } = parsed.data
  try {
    const { error } = await createServiceClient()
      .from("cities")
      .insert({
        name_ja: nameJa.trim(),
        name_en: nameEn.trim(),
        latitude: Number(latitude.trim()), // 校验通过后安全转数字
        longitude: Number(longitude.trim()),
        timezone: timezone.trim(),
      })
    if (error) {
      return error.code === "23505"
        ? { ok: false, error: "duplicate" }
        : { ok: false, error: "generic" }
    }
    return { ok: true }
  } catch {
    return { ok: false, error: "generic" }
  }
}

// 删除城市：schema 先验 → 管理员门禁 → service 客户端硬删；
// FK on delete cascade 自动清掉该城的天气数据；删 0 行映射为 notFound
export async function deleteCityAction(
  values: DeleteCityValues
): Promise<CityActionResult> {
  const parsed = deleteCitySchema.safeParse(values)
  if (!parsed.success) return { ok: false, error: "invalidInput" }
  if (!(await requireAdmin())) return { ok: false, error: "unauthorized" }

  try {
    // .select("id") 返回被删行，用于区分「删了 0 行」→ notFound
    const { data, error } = await createServiceClient()
      .from("cities")
      .delete()
      .eq("id", parsed.data.cityId)
      .select("id")
    if (error) return { ok: false, error: "generic" }
    if (!data || data.length === 0) return { ok: false, error: "notFound" }
    return { ok: true }
  } catch {
    return { ok: false, error: "generic" }
  }
}

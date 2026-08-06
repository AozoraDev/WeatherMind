import { z } from "zod"

// 城市表单 schema：错误 message 统一为 i18n key（dashboard.cities.form.errors.*），
// 字段级校验由 TanStack Form 前端触发，服务端动作再用 safeParse 复核。
// 经纬度保留字符串：避免 z.coerce.number() 把空串静默当成 0°，且便于前端 number 输入框直接回显

// 经纬度：可空 / 非有限数 / 越界 → 非法
const latLon = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .refine((v) => {
      if (!v) return false
      const n = Number(v)
      return Number.isFinite(n) && n >= min && n <= max
    }, message)

export const createCitySchema = z.object({
  nameJa: z.string().trim().min(1, "cityNameRequired"),
  nameEn: z.string().trim().min(1, "cityNameRequired"),
  latitude: latLon(-90, 90, "invalidLatitude"),
  longitude: latLon(-180, 180, "invalidLongitude"),
  timezone: z.string().trim().min(1, "timezoneRequired"),
})
export type CreateCityValues = z.infer<typeof createCitySchema>

// 删除城市：仅接受合法 uuid
export const deleteCitySchema = z.object({
  cityId: z.uuid("invalidInput"),
})
export type DeleteCityValues = z.infer<typeof deleteCitySchema>

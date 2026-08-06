// 客户端可展示的受限错误码：服务端把异常映射为这些 code，客户端按 code 取 i18n 文案，
// 不向用户泄露原始错误信息（镜像 lib/supabase/auth/errors.ts 的 AuthError 模式）
export type WeatherErrorCode = "unauthorized" | "generic"

// 手动刷新动作错误：mutationFn 中 `!res.ok` 时抛出，供 mutation.error.code 取 i18n 文案
export class WeatherError extends Error {
  code: WeatherErrorCode

  constructor(code: WeatherErrorCode) {
    super(code)
    this.name = "WeatherError"
    this.code = code
  }
}

// —— 城市增删错误 ——
export type CityErrorCode =
  "unauthorized" | "invalidInput" | "duplicate" | "notFound" | "generic"

// 城市增删动作错误：mutationFn 中 `!res.ok` 时抛出，供 mutation.error.code 取 i18n 文案
export class CityError extends Error {
  code: CityErrorCode

  constructor(code: CityErrorCode) {
    super(code)
    this.name = "CityError"
    this.code = code
  }
}

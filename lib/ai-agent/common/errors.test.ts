import { describe, expect, it } from "vitest"

import { ConversationActionError } from "./errors"

// 会话动作受限错误码类：构造时把 code 记为 message（供 mutation.error.code 取 i18n 文案）与 name，
// 照 lib/weather/errors.ts 的 WeatherError 模式
describe("ConversationActionError", () => {
  it("构造时记录受限错误码与 name", () => {
    const err = new ConversationActionError("invalidInput")
    expect(err.code).toBe("invalidInput")
    expect(err.name).toBe("ConversationActionError")
    expect(err.message).toBe("invalidInput")
  })

  it("是 Error 实例，可被 instanceof 判断", () => {
    expect(new ConversationActionError("notFound")).toBeInstanceOf(Error)
  })
})

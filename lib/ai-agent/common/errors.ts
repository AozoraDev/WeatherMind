// 客户端可展示的受限错误码：服务端动作把失败映射为这些 code，客户端按 code 取 i18n 文案，
// 不向用户泄露原始错误信息（照 lib/weather/errors.ts 的 CityError 模式）
export type ConversationActionErrorCode =
  | "unauthorized"
  | "invalidInput"
  | "notFound"
  | "generic"

// 会话动作错误：mutationFn 中 `!res.ok` 时抛出，供 mutation.error.code 取 i18n 文案
export class ConversationActionError extends Error {
  code: ConversationActionErrorCode

  constructor(code: ConversationActionErrorCode) {
    super(code)
    this.name = "ConversationActionError"
    this.code = code
  }
}

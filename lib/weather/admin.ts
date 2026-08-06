// 管理员白名单：仅该邮箱能触发手动刷新。
// 展示层据此隐藏按钮，动作层据此拒绝直调，双保险
export const ADMIN_EMAIL = "aozoradev@qq.com"

// 邮箱比较前统一小写去空格，避免大小写/空白导致误判
export function isAdminEmail(email: string | null | undefined): boolean {
  return email?.trim().toLowerCase() === ADMIN_EMAIL
}

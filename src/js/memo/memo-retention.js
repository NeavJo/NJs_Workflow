/**
 * 笔记生命周期清理：超过 RETENTION_DAYS 天的笔记自动淘汰。
 * 设计为对外部 memos 数组就地修改，便于 memo-store 直接传引用。
 */

export const RETENTION_DAYS = 7
const ONE_DAY_MS = 24 * 60 * 60 * 1000

export function cleanExpiredMemos(memos) {
  if (!Array.isArray(memos) || memos.length === 0) return 0
  const now = Date.now()
  const maxAge = RETENTION_DAYS * ONE_DAY_MS
  const before = memos.length

  for (let i = memos.length - 1; i >= 0; i--) {
    const memo = memos[i]
    const memoTime = typeof memo?.id === 'number'
      ? memo.id
      : new Date(memo?.timestamp || '').getTime()
    if (Number.isNaN(memoTime) || (now - memoTime) >= maxAge) {
      memos.splice(i, 1)
    }
  }

  return before - memos.length
}

/**
 * 轻量发布/订阅工具
 * 每个 Store 用 createPubSub() 替代手写 changeListeners Set + emitChange 函数。
 */
import { errorHandler, ErrorTypes, ErrorSeverity } from '../core/error-handler.js'

// 渲染/订阅回调异常做 5s 节流，避免高频 emit 时 toast 风暴
let lastEmitErrorAt = 0
function handleEmitError(fn, data, e) {
  errorHandler.handleError(e, {
    type: ErrorTypes.SYSTEM,
    severity: ErrorSeverity.MEDIUM,
    source: 'pubsub.emit'
  })
  const now = Date.now()
  if (now - lastEmitErrorAt > 5000) {
    lastEmitErrorAt = now
    showToast?.('渲染刷新失败，部分界面可能未更新', { status: 'error' })
  }
}

export function createPubSub() {
  const listeners = new Set()
  return {
    on(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    emit(data) {
      for (const fn of listeners) {
        try { fn(data) } catch (e) { handleEmitError(fn, data, e) }
      }
    }
  }
}

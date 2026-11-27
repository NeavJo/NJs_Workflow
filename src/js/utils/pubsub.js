/**
 * 轻量发布/订阅工具
 * 每个 Store 用 createPubSub() 替代手写 changeListeners Set + emitChange 函数。
 */
import { errorHandler, ErrorTypes, ErrorSeverity } from '../core/error-handler.js'
import { showToast } from '../ui.js'
import { I18N } from '../locales.js'

// 渲染/订阅回调异常做 5s 节流，避免高频 emit 时提示风暴
let lastEmitErrorAt = 0
function handleEmitError(fn, data, e) {
  // 这里必须保证"处理错误"本身不再抛错，否则会反过来中断 emit 循环。
  try {
    errorHandler.handleError(e, {
      type: ErrorTypes.SYSTEM,
      // LOW：这里只做记录与统计，避免和下面那条"渲染刷新失败"提示重复打扰用户
      severity: ErrorSeverity.LOW,
      source: 'pubsub.emit'
    })
  } catch (_) {
    /* 忽略：错误上报失败不应影响订阅者循环 */
  }

  const now = Date.now()
  if (now - lastEmitErrorAt > 5000) {
    lastEmitErrorAt = now
    try {
      showToast(I18N.toast.system.renderRefreshFailed, {
        status: 'error',
        event: 'render.refresh.failed'
      })
    } catch (_) {
      /* 忽略：提示失败不应影响订阅者循环 */
    }
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
      // 先快照，避免某个订阅者在回调里增删监听导致遍历异常
      for (const fn of [...listeners]) {
        // 逐个隔离：任何一个订阅者抛错，只影响它自己，后续订阅者继续执行
        try {
          fn(data)
        } catch (e) {
          handleEmitError(fn, data, e)
        }
      }
    }
  }
}

/**
 * 轻量发布/订阅工具
 * 每个 Store 用 createPubSub() 替代手写 changeListeners Set + emitChange 函数。
 */
export function createPubSub() {
  const listeners = new Set()
  return {
    on(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    emit(data) {
      for (const fn of listeners) {
        try { fn(data) } catch (e) { /* noop */ }
      }
    }
  }
}

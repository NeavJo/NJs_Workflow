/**
 * 事件管理器 - 统一管理事件监听器的绑定与清理
 * -----------------------------------------------------------------------------
 * 提供事件监听器的统一管理，确保在组件销毁时正确清理所有事件监听器，
 * 防止内存泄漏。采用渐进式优化，不改变原有业务逻辑。
 */

class EventManager {
  constructor() {
    this.listeners = new Map()
    this.timers = new Set()
    this.rafIds = new Set()
  }

  /**
   * 绑定事件监听器，返回清理函数
   */
  on(element, event, handler, options = {}) {
    if (!element || typeof element.addEventListener !== 'function') {
      console.warn('EventManager: Invalid element for event binding')
      return () => {}
    }

    element.addEventListener(event, handler, options)

    const cleanup = () => {
      element.removeEventListener(event, handler, options)
    }

    // 保存清理函数
    const key = `${event}-${handler.name || 'anonymous'}`
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set())
    }
    this.listeners.get(key).add(cleanup)

    return cleanup
  }

  /**
   * 绑定一次性事件监听器
   */
  once(element, event, handler, options = {}) {
    const wrappedHandler = (...args) => {
      handler(...args)
      this.off(element, event, wrappedHandler)
    }
    return this.on(element, event, wrappedHandler, options)
  }

  /**
   * 移除事件监听器
   */
  off(element, event, handler) {
    if (!element || typeof element.removeEventListener !== 'function') {
      return
    }

    element.removeEventListener(event, handler)
    
    // 清理存储的清理函数
    const key = `${event}-${handler.name || 'anonymous'}`
    if (this.listeners.has(key)) {
      this.listeners.get(key).delete(handler)
    }
  }

  /**
   * 批量绑定事件，返回批量清理函数
   */
  onBatch(element, events) {
    const cleanups = []
    
    events.forEach(({ event, handler, options }) => {
      const cleanup = this.on(element, event, handler, options)
      cleanups.push(cleanup)
    })

    return () => cleanups.forEach(cleanup => cleanup())
  }

  /**
   * 设置定时器，返回清理函数
   */
  setTimeout(callback, delay, ...args) {
    const timerId = setTimeout(() => {
      callback(...args)
      this.timers.delete(timerId)
    }, delay)
    
    this.timers.add(timerId)
    return () => {
      clearTimeout(timerId)
      this.timers.delete(timerId)
    }
  }

  /**
   * 设置间隔定时器，返回清理函数
   */
  setInterval(callback, interval, ...args) {
    const timerId = setInterval(() => {
      callback(...args)
    }, interval)
    
    this.timers.add(timerId)
    return () => {
      clearInterval(timerId)
      this.timers.delete(timerId)
    }
  }

  /**
   * 设置 requestAnimationFrame，返回清理函数
   */
  requestAnimationFrame(callback) {
    const rafId = requestAnimationFrame((timestamp) => {
      callback(timestamp)
      this.rafIds.delete(rafId)
    })
    
    this.rafIds.add(rafId)
    return () => {
      cancelAnimationFrame(rafId)
      this.rafIds.delete(rafId)
    }
  }

  /**
   * 清理所有事件监听器
   */
  cleanup() {
    // 清理所有事件监听器
    this.listeners.forEach((cleanups, key) => {
      cleanups.forEach(cleanup => cleanup())
    })
    this.listeners.clear()

    // 清理所有定时器
    this.timers.forEach(timerId => {
      clearTimeout(timerId)
      clearInterval(timerId)
    })
    this.timers.clear()

    // 清理所有 rAF
    this.rafIds.forEach(rafId => {
      cancelAnimationFrame(rafId)
    })
    this.rafIds.clear()
  }

  /**
   * 创建子事件管理器（用于组件级管理）
   */
  createChild() {
    const child = new EventManager()
    
    // 绑定清理函数到父管理器
    const childCleanup = child.cleanup.bind(child)
    this.on(window, 'beforeunload', childCleanup)
    
    return child
  }
}

// 创建全局事件管理器实例
const globalEventManager = new EventManager()

/**
 * 便捷的全局事件绑定函数
 */
export function bindEvent(element, event, handler, options = {}) {
  return globalEventManager.on(element, event, handler, options)
}

/**
 * 便捷的全局一次性事件绑定函数
 */
export function bindOnce(element, event, handler, options = {}) {
  return globalEventManager.once(element, event, handler, options)
}

/**
 * 便捷的全局批量事件绑定函数
 */
export function bindBatch(element, events) {
  return globalEventManager.onBatch(element, events)
}

/**
 * 便捷的全局定时器设置函数
 */
export function setTimer(callback, delay, ...args) {
  return globalEventManager.setTimeout(callback, delay, ...args)
}

/**
 * 便捷的全局间隔定时器设置函数
 */
export function setIntervalTimer(callback, interval, ...args) {
  return globalEventManager.setInterval(callback, interval, ...args)
}

/**
 * 便捷的全局 requestAnimationFrame 设置函数
 */
export function setAnimationFrame(callback) {
  return globalEventManager.requestAnimationFrame(callback)
}

/**
 * 清理所有全局事件监听器
 */
export function cleanupAllEvents() {
  globalEventManager.cleanup()
}

// 导出事件管理器实例供高级使用
export { globalEventManager }
export default EventManager
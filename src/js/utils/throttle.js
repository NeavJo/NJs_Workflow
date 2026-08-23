/**
 * 节流与防抖工具函数
 * -----------------------------------------------------------------------------
 * 提供 throttle（节流）和 debounce（防抖）工具，用于优化高频事件触发。
 * 采用渐进式优化，不改变原有业务逻辑。
 */

/**
 * 节流函数：在 delay 毫秒内最多执行一次
 * - 采用 leading + trailing 模式，确保首次立即执行，末尾补一次
 */
export function throttle(func, delay) {
  let lastExecTime = 0
  let timeoutId = null

  function throttled(...args) {
    const currentTime = Date.now()
    const timeSinceLastExec = currentTime - lastExecTime

    if (timeSinceLastExec > delay) {
      // 立即执行
      lastExecTime = currentTime
      func.apply(this, args)
    } else {
      // 延迟执行，确保 trailing 调用
      clearTimeout(timeoutId)
      timeoutId = setTimeout(() => {
        lastExecTime = Date.now()
        func.apply(this, args)
      }, delay - timeSinceLastExec)
    }
  }

  throttled.cancel = () => {
    clearTimeout(timeoutId)
    timeoutId = null
    lastExecTime = 0
  }

  return throttled
}

/**
 * 防抖函数：在 delay 毫秒内多次触发只执行最后一次
 */
export function debounce(func, delay) {
  let timeoutId = null

  function debounced(...args) {
    clearTimeout(timeoutId)
    timeoutId = setTimeout(() => {
      timeoutId = null
      func.apply(this, args)
    }, delay)
  }

  debounced.cancel = () => {
    clearTimeout(timeoutId)
    timeoutId = null
  }

  return debounced
}

/**
 * rAF 节流：使用 requestAnimationFrame 节流，适合 DOM 操作
 */
export function rafThrottle(func) {
  let rafId = null
  let lastArgs = null

  function throttled(...args) {
    lastArgs = args
    if (rafId) return
    rafId = requestAnimationFrame(() => {
      rafId = null
      if (lastArgs) {
        func.apply(this, lastArgs)
        lastArgs = null
      }
    })
  }

  throttled.cancel = () => {
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    lastArgs = null
  }

  return throttled
}
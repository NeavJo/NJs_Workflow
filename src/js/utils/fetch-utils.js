/**
 * 通用 fetch 工具：带超时控制的 fetch 请求。
 * 返回 Promise<{ status, ok, data, rawText, error? }>，永不 reject。
 */

/**
 * 带超时的 fetch 请求。
 * @param {string} url - 请求 URL
 * @param {RequestInit} init - fetch init 选项
 * @param {number} timeout - 超时毫秒数，默认 10000
 * @param {string} [timeoutMsg] - 超时错误提示文案，默认为 'timeout'
 * @returns {Promise<{status:number, ok:boolean, data:*, rawText:string, error?:string}>}
 */
export function fetchWithTimeout(url, init, timeout = 10000, timeoutMsg = 'timeout') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  return fetch(url, { ...init, signal: controller.signal })
    .then(async (res) => {
      clearTimeout(timer)
      const text = await res.text()
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { data = null }
      return { status: res.status, ok: res.ok, data, rawText: text }
    })
    .catch((err) => {
      clearTimeout(timer)
      const aborted = err && err.name === 'AbortError'
      return {
        status: 0,
        ok: false,
        data: null,
        rawText: '',
        error: aborted ? timeoutMsg : String(err)
      }
    })
}

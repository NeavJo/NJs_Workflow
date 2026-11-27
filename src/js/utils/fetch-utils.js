import { DBG } from '../core/debug.js'

/**
 * 通用 fetch 工具：带超时控制的 fetch 请求。
 * 返回 Promise<{ status, ok, data, rawText, error? }>，永不 reject。
 */

/**
 * 带超时的 fetch 请求。
 * 支持外部取消：调用方可在 init.signal 上传入 AbortSignal，
 * 外部取消时以 error='aborted' 返回（与超时区分），便于上层区分"用户取消"与"请求超时"。
 * @param {string} url - 请求 URL
 * @param {RequestInit} init - fetch init 选项（可含 signal）
 * @param {number} timeout - 超时毫秒数，默认 10000
 * @param {string} [timeoutMsg] - 超时错误提示文案，默认为 'timeout'
 * @returns {Promise<{status:number, ok:boolean, data:*, rawText:string, error?:string}>}
 */
export function fetchWithTimeout(url, init, timeout = 10000, timeoutMsg = 'timeout') {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const externalSignal = init && init.signal
  let abortedByCaller = false
  const onExternalAbort = () => {
    abortedByCaller = true
    controller.abort()
  }
  if (externalSignal) {
    if (externalSignal.aborted) onExternalAbort()
    else externalSignal.addEventListener('abort', onExternalAbort, { once: true })
  }
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
      // 网络层异常（断网、DNS、CORS 等）只保留异常类型供日志排查，
      // 不把浏览器原文（如 "TypeError: Failed to fetch"）透传给用户；
      // error 留空，由调用方按 status===0 回落到本地化 networkError 文案。
      if (!aborted) DBG('fetch:network-error', { type: err?.name || 'Error' })
      return {
        status: 0,
        ok: false,
        data: null,
        rawText: '',
        error: aborted ? (abortedByCaller ? 'aborted' : timeoutMsg) : ''
      }
    })
    .finally(() => {
      if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort)
    })
}

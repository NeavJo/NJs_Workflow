import { DBG } from '../core/debug.js'
import { getGistSettings, hasGistCredentials } from '../core/settings-store.js'

/**
 * GitHub Gist REST API 的薄包装：
 *  - path: 'gists' 或 'gists/{id}'
 *  - opts: { method, body }
 *  - 返回 Promise<{ status, ok, data, rawText, error? }>，永不走 reject 抛错。
 *
 * 由 backup/gist-sync.js 在 upload/pull 时调用。
 */

export const GIST_API_BASE = 'https://api.github.com'
export const GIST_FILENAME = 'njw_backup.json'
export const GIST_REQUEST_TIMEOUT = 12000

export function gistApiRequest(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase()
  const url = `${GIST_API_BASE}/${path.replace(/^\/+/, '')}`
  const settings = getGistSettings()
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  }
  if (settings.token) headers.Authorization = `Bearer ${settings.token}`
  const init = { method, headers }
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GIST_REQUEST_TIMEOUT)
  init.signal = controller.signal
  return fetch(url, init)
    .then(async (res) => {
      clearTimeout(timer)
      const text = await res.text()
      let data = null
      try { data = text ? JSON.parse(text) : null } catch { data = null }
      return { status: res.status, ok: res.ok, data, rawText: text }
    })
    .catch((err) => {
      clearTimeout(timer)
      DBG('gist:request:error', { path, method, err: String(err) })
      return { status: 0, ok: false, data: null, rawText: '', error: String(err) }
    })
}

/**
 * 列举一组 Gist 同步时用到的网络错误中文提示。
 */
export function gistErrorMessage(res, { kind = 'upload' } = {}) {
  if (res.status === 401) return '认证失败：Token 无效或已过期。'
  if (res.status === 404) return '找不到该 Gist，请检查 Gist ID。'
  if (res.status === 0) return '网络异常，' + (kind === 'upload' ? '上传失败。' : '拉取失败。')
  return (kind === 'upload' ? '上传失败' : '拉取失败') + `（HTTP ${res.status}）`
}

export { hasGistCredentials }

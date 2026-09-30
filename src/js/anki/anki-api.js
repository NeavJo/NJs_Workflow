import { DBG } from '../core/debug.js'
import { I18N, t } from '../locales.js'
import { fetchWithTimeout } from '../utils/fetch-utils.js'

/**
 * Anki LLM API 薄包装：
 *  - requestGemini：Google Gemini 原生 generateContent 接口。
 *  - requestOpenAI：通用 OpenAI 兼容 /chat/completions 接口。
 *  两者均使用 AbortController + 30s 超时（LLM 响应慢于 Gist 12s 基线）。
 *  返回 Promise<{ ok, text, status, error }>，永不 reject；apiKey 不写入日志。
 */

export const ANKI_API_TIMEOUT = 30000

/**
 * 校验 baseUrl 是否可解析为合法 http(s) URL。
 * 与 storage-config.isValidAnkiBaseUrl 语义一致；此处独立实现避免跨模块循环依赖。
 */
export function isValidAnkiBaseUrl(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  if (!text) return false
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 构造 Gemini 请求 URL。
 * 健壮性（§6.5）：baseUrl 或 modelId 缺失/非法时返回 null，
 * 调用方据此返回明确错误而非拼出坏 URL。
 * @returns {string|null}
 */
function buildGeminiUrl(baseUrl, modelId) {
  if (!isValidAnkiBaseUrl(baseUrl)) return null
  const model = typeof modelId === 'string' ? modelId.trim() : ''
  if (!model) return null
  const root = baseUrl.replace(/\/+$/, '')
  return `${root}/v1beta/models/${encodeURIComponent(model)}:generateContent`
}

function buildOpenAIUrl(baseUrl) {
  if (!isValidAnkiBaseUrl(baseUrl)) return null
  const root = baseUrl.replace(/\/+$/, '')
  if (/\/chat\/completions$/.test(root)) return root
  return `${root}/chat/completions`
}

/**
 * Google Gemini 原生 API。
 * URL: {baseUrl}/v1beta/models/{modelId}:generateContent?key={apiKey}
 */
export function requestGemini({ baseUrl, modelId, apiKey, systemPrompt, userMessage }) {
  const url = buildGeminiUrl(baseUrl, modelId)
  if (!url) {
    DBG('anki:gemini:bad-url', { hasBaseUrl: Boolean(baseUrl), modelId })
    return Promise.resolve({ ok: false, status: 0, text: '', error: I18N.toast.system.badConfig })
  }
  const fullUrl = `${url}?key=${encodeURIComponent(apiKey || '')}`
  const body = {
    contents: [{ parts: [{ text: userMessage || '' }] }],
    systemInstruction: { parts: [{ text: systemPrompt || '' }] }
  }
  DBG('anki:gemini:request', { modelId, hasKey: Boolean(apiKey), systemPromptLen: (systemPrompt || '').length })
  return fetchWithTimeout(fullUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }, ANKI_API_TIMEOUT, I18N.toast.system.timeout).then((res) => {
    if (!res.ok || !res.data) {
      return { ok: false, status: res.status, text: '', error: geminiErrorMessage(res) }
    }
    const candidate = res.data.candidates && res.data.candidates[0]
    const parts = candidate && candidate.content && candidate.content.parts
    const text = Array.isArray(parts) ? parts.map((p) => p.text || '').join('') : ''
    if (!text) {
      return { ok: false, status: res.status, text: '', error: I18N.toast.system.apiEmpty }
    }
    return { ok: true, status: res.status, text, error: '' }
  })
}

/**
 * 通用 OpenAI 兼容接口。
 * URL: {baseUrl}/chat/completions（已含则原样使用）
 */
export function requestOpenAI({ baseUrl, modelId, apiKey, systemPrompt, userMessage }) {
  const url = buildOpenAIUrl(baseUrl)
  if (!url) {
    DBG('anki:openai:bad-url', { hasBaseUrl: Boolean(baseUrl), modelId })
    return Promise.resolve({ ok: false, status: 0, text: '', error: I18N.toast.system.badConfig })
  }
  const body = {
    model: modelId,
    messages: [
      { role: 'system', content: systemPrompt || '' },
      { role: 'user', content: userMessage || '' }
    ],
    stream: false
  }
  DBG('anki:openai:request', { modelId, hasKey: Boolean(apiKey), systemPromptLen: (systemPrompt || '').length })
  return fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey || ''}`
    },
    body: JSON.stringify(body)
  }, ANKI_API_TIMEOUT, I18N.toast.system.timeout).then((res) => {
    if (!res.ok || !res.data) {
      return { ok: false, status: res.status, text: '', error: openaiErrorMessage(res) }
    }
    const choice = res.data.choices && res.data.choices[0]
    const text = choice && choice.message ? (choice.message.content || '') : ''
    if (!text) {
      return { ok: false, status: res.status, text: '', error: I18N.toast.system.apiEmpty }
    }
    return { ok: true, status: res.status, text, error: '' }
  })
}

function geminiErrorMessage(res) {
  if (res.status === 0) return res.error || I18N.toast.system.networkError
  if (res.status === 400) return I18N.toast.system.gemini400
  if (res.status === 401 || res.status === 403) return t(I18N.toast.system.gemini401, { status: res.status })
  if (res.status === 404) return I18N.toast.system.gemini404
  if (res.status === 429) return I18N.toast.system.gemini429
  return t(I18N.toast.system.geminiHttp, { status: res.status })
}

function openaiErrorMessage(res) {
  if (res.status === 0) return res.error || I18N.toast.system.networkError
  if (res.status === 401) return I18N.toast.system.openai401
  if (res.status === 404) return I18N.toast.system.openai404
  if (res.status === 429) return I18N.toast.system.openai429
  return t(I18N.toast.system.openaiHttp, { status: res.status })
}

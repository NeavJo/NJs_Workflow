export const WORKFLOWS_STORAGE_KEY = 'njs-workflow-config'

export const COMPLETION_HISTORY_STORAGE_KEY = 'njs-workflow-completion-history'

export const LAST_RESET_DATE_STORAGE_KEY = 'njs-workflow-last-reset-date'

export const GIST_SETTINGS_STORAGE_KEY = 'njs-workflow-gist-settings'

export const USER_SETTINGS_STORAGE_KEY = 'njs-workflow-user-settings'

export const ANKI_SETTINGS_STORAGE_KEY = 'njs-workflow-anki-settings'

export const DEFAULT_ANKI_SETTINGS = Object.freeze({
  apiType: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com',
  modelId: 'gemini-3.5-flash-lite',
  apiKey: '',
  apiKeyEncrypted: '',
  prompt: ''
})

export const ANKI_API_TYPES = ['gemini', 'openai']

export const DEFAULT_GIST_SETTINGS = Object.freeze({
  token: '',
  gistId: '',
  lastSyncAction: '',
  lastSyncTime: ''
})

export const DEFAULT_USER_SETTINGS = Object.freeze({})

export function normalizeGistSettings(raw) {
  const safe = raw && typeof raw === 'object' ? raw : {}
  const validActions = new Set(['', 'upload', 'pull'])
  const action = validActions.has(safe.lastSyncAction) ? safe.lastSyncAction : ''
  const time = typeof safe.lastSyncTime === 'string' ? safe.lastSyncTime : ''
  return {
    token: typeof safe.token === 'string' ? safe.token : '',
    gistId: typeof safe.gistId === 'string' ? safe.gistId : '',
    lastSyncAction: action,
    lastSyncTime: time
  }
}

export function normalizeCompletionHistory(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result = {}
  for (const key of Object.keys(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
    const list = raw[key]
    if (!Array.isArray(list)) continue
    const ids = [...new Set(list.filter((x) => typeof x === 'string' && x))]
    if (ids.length) result[key] = ids
  }
  return result
}

export function normalizeUserSettings(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result = {}
  for (const key of Object.keys(raw)) {
    const v = raw[key]
    if (typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') {
      result[key] = v
    }
  }
  return result
}

export function normalizeAnkiSettings(raw) {
  const safe = raw && typeof raw === 'object' ? raw : {}
  const apiType = ANKI_API_TYPES.includes(safe.apiType) ? safe.apiType : 'gemini'
  const baseUrl = typeof safe.baseUrl === 'string' ? safe.baseUrl.trim() : ''
  const modelId = typeof safe.modelId === 'string' ? safe.modelId.trim() : ''
  const apiKey = typeof safe.apiKey === 'string' ? safe.apiKey : ''
  const apiKeyEncrypted = typeof safe.apiKeyEncrypted === 'string' ? safe.apiKeyEncrypted : ''
  const prompt = typeof safe.prompt === 'string' ? safe.prompt.trim() : ''
  return { apiType, baseUrl, modelId, apiKey, apiKeyEncrypted, prompt }
}

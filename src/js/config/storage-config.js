export const WORKFLOWS_STORAGE_KEY = 'njs-workflow-config'

export const COMPLETION_HISTORY_STORAGE_KEY = 'njs-workflow-completion-history'

export const LAST_RESET_DATE_STORAGE_KEY = 'njs-workflow-last-reset-date'

export const GIST_SETTINGS_STORAGE_KEY = 'njs-workflow-gist-settings'

export const USER_SETTINGS_STORAGE_KEY = 'njs-workflow-user-settings'

export const ANKI_SETTINGS_STORAGE_KEY = 'njs-workflow-anki-settings'

export const ANKI_API_TYPES = ['gemini', 'openai']

export const DEFAULT_ANKI_PROFILE = Object.freeze({
  id: '',
  name: '',
  apiType: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com',
  modelId: 'gemini-3.5-flash-lite',
  apiKey: '',
  apiKeyEncrypted: ''
})

export const DEFAULT_ANKI_SETTINGS = Object.freeze({
  profiles: [
    {
      id: '',
      name: '',
      apiType: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      modelId: 'gemini-3.5-flash-lite',
      apiKey: '',
      apiKeyEncrypted: ''
    }
  ],
  activeProfileId: '',
  prompt: ''
})

export const DEFAULT_GIST_SETTINGS = Object.freeze({
  token: '',
  gistId: '',
  lastSyncAction: '',
  lastSyncTime: ''
})

export const DEFAULT_USER_SETTINGS = Object.freeze({})

function generateAnkiProfileId() {
  const random =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  return `anki-profile-${random}`
}

function normalizeAnkiApiType(value) {
  return ANKI_API_TYPES.includes(value) ? value : 'gemini'
}

function normalizeAnkiBaseUrl(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return text
  try {
    return new URL(text).toString()
  } catch {
    return text
  }
}

export function normalizeAnkiProfile(raw, index = 0, fallbackName = '') {
  const safe = raw && typeof raw === 'object' ? raw : {}
  const name = typeof safe.name === 'string' ? safe.name.trim() : ''
  return {
    id: typeof safe.id === 'string' && safe.id.trim() ? safe.id.trim() : generateAnkiProfileId(),
    name: name || fallbackName || `模型 ${index + 1}`,
    apiType: normalizeAnkiApiType(safe.apiType),
    baseUrl: normalizeAnkiBaseUrl(safe.baseUrl),
    modelId: typeof safe.modelId === 'string' ? safe.modelId.trim() : '',
    apiKey: typeof safe.apiKey === 'string' ? safe.apiKey : '',
    apiKeyEncrypted: typeof safe.apiKeyEncrypted === 'string' ? safe.apiKeyEncrypted : ''
  }
}

export function normalizeAnkiSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  // 旧版 localStorage / 备份可能保存单对象：
  // { apiType, baseUrl, modelId, apiKey, apiKeyEncrypted, prompt }
  // 先检测"单配置"形态，再迁移为一个档案，避免旧用户升级后配置丢失。
  const looksLikeLegacySingleProfile =
    Object.prototype.hasOwnProperty.call(source, 'apiType') ||
    Object.prototype.hasOwnProperty.call(source, 'baseUrl') ||
    Object.prototype.hasOwnProperty.call(source, 'modelId') ||
    Object.prototype.hasOwnProperty.call(source, 'apiKey') ||
    Object.prototype.hasOwnProperty.call(source, 'apiKeyEncrypted')

  let rawProfiles
  if (Array.isArray(source.profiles)) {
    rawProfiles = source.profiles
  } else if (looksLikeLegacySingleProfile) {
    rawProfiles = [source]
  } else {
    rawProfiles = []
  }

  let profiles = rawProfiles
    .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
    .map((item, index) => normalizeAnkiProfile(item, index))

  if (profiles.length === 0) {
    profiles = [
      {
        ...normalizeAnkiProfile(DEFAULT_ANKI_PROFILE, 0),
        id: generateAnkiProfileId()
      }
    ]
  }

  const idSet = new Set(profiles.map((profile) => profile.id))
  // 保持"至少一个档案"不变量：UI 可临时删到 0 个再新增；
  // 写入存储前 normalizeAnkiSettings 会兜底一个默认档案。
  let activeProfileId = typeof source.activeProfileId === 'string' ? source.activeProfileId.trim() : ''
  if (!idSet.has(activeProfileId)) {
    // 旧版没有 activeProfileId；优先沿用旧单配置迁移出的档案。
    activeProfileId =
      looksLikeLegacySingleProfile && profiles.length > 0 ? profiles[0].id : profiles[0].id
  }

  return {
    profiles,
    activeProfileId,
    prompt: typeof source.prompt === 'string' ? source.prompt.trim() : ''
  }
}

export function createAnkiProfile(partial = {}, index = 0) {
  const profile = normalizeAnkiProfile({
    ...DEFAULT_ANKI_PROFILE,
    ...partial,
    id: partial?.id || generateAnkiProfileId(),
    name: partial?.name || `模型 ${index + 1}`
  }, index)
  return profile
}

export function getActiveAnkiProfile(settings) {
  const normalized = normalizeAnkiSettings(settings)
  const active = normalized.profiles.find((profile) => profile.id === normalized.activeProfileId)
  return active || normalized.profiles[0]
}

export function hasAnkiProfileCredentials(profile) {
  if (!profile || typeof profile !== 'object') return false
  const hasModel = Boolean(profile.modelId)
  const hasKey = Boolean(profile.apiKey)
  // baseUrl 必须能解析为合法 URL（§6.5）：避免把坏 URL 拼进请求体；
  // 仅当三者齐备时判定"可运行"。
  const hasUrl = Boolean(profile.baseUrl) && isValidAnkiBaseUrl(profile.baseUrl)
  return hasModel && hasKey && hasUrl
}

/**
 * 校验 baseUrl 是否可解析为合法 URL（http/https），供 hasAnkiProfileCredentials 使用。
 * 仅做格式校验，不校验域名；失败返回 false 由调用方决定是否发起请求。
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
    const value = raw[key]
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    // 新规范要求 daily record 是对象；旧数组等不符合规范的记录直接清空
    const ids = Array.isArray(value.completedIds)
      ? [...new Set(value.completedIds.filter((x) => typeof x === 'string' && x))]
      : []
    const totalTasks = Number.isInteger(value.totalTasks) && value.totalTasks >= 0 ? value.totalTasks : null
    if (ids.length === 0 && totalTasks === null) continue
    result[key] = { completedIds: ids, totalTasks }
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

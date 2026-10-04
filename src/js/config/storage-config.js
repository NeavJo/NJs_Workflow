export const WORKFLOWS_STORAGE_KEY = 'njs-workflow-config'

export const COMPLETION_HISTORY_STORAGE_KEY = 'njs-workflow-completion-history'

export const LAST_RESET_DATE_STORAGE_KEY = 'njs-workflow-last-reset-date'

export const GIST_SETTINGS_STORAGE_KEY = 'njs-workflow-gist-settings'

export const USER_SETTINGS_STORAGE_KEY = 'njs-workflow-user-settings'

export const ANKI_SETTINGS_STORAGE_KEY = 'njs-workflow-anki-settings'

export const ANKI_EXPORT_SETTINGS_STORAGE_KEY = 'njs-workflow-anki-export-settings'

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

// 笔记类型默认字段名：与 Prompt 约定的 3 字段（F1 | F2 | F3）一一对应。
// 仅作为未填写时的兜底；实际字段数量由用户在设置里填写，允许目标笔记类型有更多字段
// （例如第 4 个字段由用户手动补充，导出时留空占位）。
export const DEFAULT_ANKI_EXPORT_FIELD_NAMES = Object.freeze(['Front', 'Back', 'Example'])

// 默认卡片模板名。Anki 在无数字 ID 时按「模板名」匹配模板，
// 名称不一致会追加一个新模板从而多生成一张卡，因此同样需要可配置。
export const DEFAULT_ANKI_EXPORT_TEMPLATE_NAME = 'Card 1'

export const DEFAULT_ANKI_EXPORT_SETTINGS = Object.freeze({
  tagConfigs: {},
  defaultConfig: {
    deckName: 'Import::Anki',
    modelName: 'Basic',
    // 手动指定的目标笔记类型 ID（字符串形式的纯数字）：留空则维持旧的自动新建行为。
    // Anki 导入 APKG 时按内部数字 ID 匹配笔记类型，只有给出同一 ID 才会复用已有类型。
    modelId: '',
    // 目标笔记类型的前 3 个字段名，需与 Anki 中已有笔记类型一致才能干净复用（不新增字段）。
    fieldNames: [...DEFAULT_ANKI_EXPORT_FIELD_NAMES],
    // 目标笔记类型的模板名，需与已有模板一致，避免 Anki 追加模板导致重复出卡。
    templateName: DEFAULT_ANKI_EXPORT_TEMPLATE_NAME
  }
})

/**
 * 归一化笔记类型 ID：只接受纯数字字符串，其余一律视为空（未指定）。
 * Anki 的 NotetypeId 是 i64，写入非数字会在 models JSON 里形成非法 id 导致导入失败。
 */
export function normalizeAnkiModelId(value) {
  const text = typeof value === 'string'
    ? value.trim()
    : typeof value === 'number' && Number.isFinite(value)
      ? String(Math.trunc(value))
      : ''
  return /^\d+$/.test(text) ? text : ''
}

/**
 * 归一化导出字段名：保留用户填写的字段数量（不再固定 3 个）。
 *  - 目标笔记类型的字段数必须与之完全一致（Anki 的 equal_schema 逐位按名+数量比对），
 *    因此这里不能截断或补齐到固定长度，否则字段数不符会触发 Anki 克隆出新类型。
 *  - 空缺位置（空串）回落到同名位置的默认名；尾部连续空缺直接丢弃，避免生成无名字段。
 *  - 无有效输入时返回默认三字段的副本。
 */
export function normalizeAnkiExportFieldNames(value) {
  const list = Array.isArray(value) ? value : []
  const names = []
  for (let i = 0; i < list.length; i += 1) {
    const name = typeof list[i] === 'string' ? list[i].trim() : ''
    names.push(name || DEFAULT_ANKI_EXPORT_FIELD_NAMES[i] || '')
  }
  // 仅裁掉尾部空白字段名，保留中间位置以维持与 Prompt 字段顺序的一一对应。
  while (names.length > 0 && !names[names.length - 1]) names.pop()
  if (names.length === 0) return [...DEFAULT_ANKI_EXPORT_FIELD_NAMES]
  return names
}

/**
 * 归一化模板名：空串回落到默认模板名，避免出现无名模板导致 Anki 追加模板。
 */
export function normalizeAnkiExportTemplateName(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  return text || DEFAULT_ANKI_EXPORT_TEMPLATE_NAME
}

/**
 * 校验导出字段名列表是否可用于生成目标笔记类型。
 * Anki 的笔记类型要求字段名唯一且非空：重复名会让模板 `{{字段名}}` 指向多个字段、
 * 并使 equal_schema 比对失败；空名会写出无名字段，导入后表现为异常卡片。
 * 返回 null 表示合法，否则返回 { reason, ... } 供调用方提示。
 */
export function validateAnkiExportFieldNames(fieldNames) {
  const list = Array.isArray(fieldNames) ? fieldNames : []
  if (list.length === 0) return { reason: 'empty-list' }
  const seen = new Set()
  for (let i = 0; i < list.length; i += 1) {
    const name = typeof list[i] === 'string' ? list[i].trim() : ''
    if (!name) return { reason: 'empty', index: i }
    if (seen.has(name)) return { reason: 'duplicate', name }
    seen.add(name)
  }
  return null
}

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

export function normalizeAnkiExportSettings(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const tagConfigs = {}
  const rawTagConfigs = source.tagConfigs && typeof source.tagConfigs === 'object' && !Array.isArray(source.tagConfigs)
    ? source.tagConfigs
    : {}
  for (const key of Object.keys(rawTagConfigs)) {
    const value = rawTagConfigs[key]
    if (!value || typeof value !== 'object') continue
    const deckName = typeof value.deckName === 'string' ? value.deckName.trim() : ''
    const modelName = typeof value.modelName === 'string' ? value.modelName.trim() : ''
    if (!deckName || !modelName) continue
    tagConfigs[key] = {
      deckName,
      modelName,
      modelId: normalizeAnkiModelId(value.modelId),
      fieldNames: normalizeAnkiExportFieldNames(value.fieldNames),
      templateName: normalizeAnkiExportTemplateName(value.templateName)
    }
  }
  const rawDefault = source.defaultConfig && typeof source.defaultConfig === 'object' && !Array.isArray(source.defaultConfig)
    ? source.defaultConfig
    : {}
  const defaultDeckName = typeof rawDefault.deckName === 'string' ? rawDefault.deckName.trim() : ''
  const defaultModelName = typeof rawDefault.modelName === 'string' ? rawDefault.modelName.trim() : ''
  return {
    tagConfigs,
    defaultConfig: {
      deckName: defaultDeckName || DEFAULT_ANKI_EXPORT_SETTINGS.defaultConfig.deckName,
      modelName: defaultModelName || DEFAULT_ANKI_EXPORT_SETTINGS.defaultConfig.modelName,
      modelId: normalizeAnkiModelId(rawDefault.modelId),
      fieldNames: normalizeAnkiExportFieldNames(rawDefault.fieldNames),
      templateName: normalizeAnkiExportTemplateName(rawDefault.templateName)
    }
  }
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

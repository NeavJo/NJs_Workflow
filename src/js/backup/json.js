import { DBG } from '../core/debug.js'
import { I18N, t } from '../locales.js'
import {
  COMPLETION_HISTORY_STORAGE_KEY,
  LAST_RESET_DATE_STORAGE_KEY,
  USER_SETTINGS_STORAGE_KEY,
  WORKFLOWS_STORAGE_KEY,
  ANKI_SETTINGS_STORAGE_KEY,
  DEFAULT_ANKI_SETTINGS,
  normalizeCompletionHistory,
  normalizeUserSettings,
  normalizeAnkiSettings
} from '../config/storage-config.js'
import { ROTATION_RULES_STORAGE_KEY } from '../config/rotation-rules.js'
import { MEMO_STORAGE_KEY } from '../core/storage.js'
import { MEMO_TAGS_STORAGE_KEY } from '../config/memo-tags.js'

import {
  DEFAULT_WORKFLOWS,
  normalizeTask
} from '../config/workflow-config.js'
import {
  DEFAULT_ROTATION_RULES,
  normalizeRotationRuleList
} from '../config/rotation-rules.js'
import { formatTimestamp } from '../core/date.js'
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '../core/storage.js'

/**
 * 备份文件校验 + 反向归一化 + 原子写入本地存储。
 *  - validateBackupPayload：检测 1.0 / 1.1 / 1.2 结构合法性
 *  - normalizeBackupPayload：得到 { workflows, rotationRules, memos,
 *                               completionHistory, lastResetDate, userSettings }
 *  - persistBackupToStorage：原子写，失败回滚前序写入
 */

const STORAGE_KEYS_FOR_IMPORT = {
  workflows: WORKFLOWS_STORAGE_KEY,
  rotationRules: ROTATION_RULES_STORAGE_KEY,
  memos: MEMO_STORAGE_KEY,
  completionHistory: COMPLETION_HISTORY_STORAGE_KEY,
  lastResetDate: LAST_RESET_DATE_STORAGE_KEY,
  userSettings: USER_SETTINGS_STORAGE_KEY,
  ankiSettings: ANKI_SETTINGS_STORAGE_KEY,
  memoTags: MEMO_TAGS_STORAGE_KEY
}

/**
 * 验证备份文件结构。支持 1.0 / 1.1 / 1.2 系列。
 * 返回 null 表示 OK，否则返回错误文案。
 */
export function validateBackupPayload(raw) {
  if (!raw || typeof raw !== 'object') return '备份文件结构为空或格式不合法。'
  const ver = typeof raw.version === 'string' ? raw.version : ''
  const supported = ver.startsWith('1.0') || ver.startsWith('1.1') || ver.startsWith('1.2') || ver.startsWith('1.3')
  if (!supported) {
    return `不兼容的备份版本：${ver || '未知'}，需要 1.0 / 1.1 / 1.2 / 1.3 系列。`
  }
  if (!raw.data || typeof raw.data !== 'object') return '备份文件缺少 data 字段。'
  if (!Array.isArray(raw.data.workflows)) return 'data.workflows 应为任务数组。'
  if (!Array.isArray(raw.data.memos)) return 'data.memos 应为笔记数组。'
  if (raw.data.completionHistory !== undefined &&
      (typeof raw.data.completionHistory !== 'object' || Array.isArray(raw.data.completionHistory) || raw.data.completionHistory === null)) {
    return 'data.completionHistory 应为对象。'
  }
  if (raw.data.userSettings !== undefined &&
      (typeof raw.data.userSettings !== 'object' || Array.isArray(raw.data.userSettings) || raw.data.userSettings === null)) {
    return 'data.userSettings 应为对象。'
  }
  if (raw.data.ankiSettings !== undefined &&
      (typeof raw.data.ankiSettings !== 'object' || Array.isArray(raw.data.ankiSettings) || raw.data.ankiSettings === null)) {
    return 'data.ankiSettings 应为对象。'
  }

  return null
}

/**
 * 把 raw 备份 payload 反向归一化为应用层可用的数据形状。
 *  - 任何字段缺失/格式错误都会用当前数据兜底：
 *    workflows 为空 → 使用 DEFAULT_WORKFLOWS
 *    rotationRules 为空 → 仅保证 CET-6 默认规则存在
 *    memos / history / userSettings 走 normalizeXxx
 */
export function normalizeBackupPayload(payload, { fallbackLastReset = '' } = {}) {
  const normalizedWf = payload.data.workflows
    .map((rawWf) => {
      const t = normalizeTask(rawWf)
      if (t && typeof rawWf?.hasDynamicTag === 'boolean') t.hasDynamicTag = rawWf.hasDynamicTag
      if (t && typeof rawWf?.rotationRuleId === 'string') t.rotationRuleId = rawWf.rotationRuleId
      return normalizeTask(t)
    })
    .filter(Boolean)

  const importedWorkflows = normalizedWf.length > 0
    ? normalizedWf
    : DEFAULT_WORKFLOWS.map((t) => normalizeTask({ ...t })).filter(Boolean)

  const importedRotationRuleList = Array.isArray(payload.data.rotationRules)
    ? normalizeRotationRuleList(payload.data.rotationRules)
    : []
  for (const def of JSON.parse(JSON.stringify(DEFAULT_ROTATION_RULES))) {
    if (!importedRotationRuleList.find((r) => r.id === def.id)) importedRotationRuleList.push(def)
  }

  const importedMemos = payload.data.memos
    .map((m) => {
      if (!m || typeof m !== 'object') return null
      const id = typeof m.id === 'number' ? m.id : Date.now()
      const content = typeof m.content === 'string' ? m.content : ''
      if (!content.trim()) return null
      return {
        id,
        timestamp: typeof m.timestamp === 'string' ? m.timestamp : formatTimestamp(new Date(id)),
        tag: typeof m.tag === 'string' && m.tag.startsWith('#') ? m.tag : '#Deutsch/Anki',
        content
      }
    })
    .filter(Boolean)

  const importedHistory = normalizeCompletionHistory(payload.data.completionHistory || {})
  const importedLastReset = (typeof payload.data.lastResetDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(payload.data.lastResetDate)) ? payload.data.lastResetDate : fallbackLastReset
  const importedUserSettings = normalizeUserSettings(payload.data.userSettings || {})
  // ankiSettings 在 1.3 起加入；旧版备份缺失时保留当前本地配置，避免覆盖用户已配置的 API Key。
  const importedAnkiSettings = payload.data.ankiSettings !== undefined
    ? normalizeAnkiSettings(payload.data.ankiSettings)
    : normalizeAnkiSettings(safeStorageGet(ANKI_SETTINGS_STORAGE_KEY, DEFAULT_ANKI_SETTINGS))
  
  // memoTags 处理：如果备份中有数据则使用，否则保留当前本地数据
  const importedMemoTags = Array.isArray(payload.data.memoTags) ? payload.data.memoTags : []



  return {
      workflows: importedWorkflows,
      rotationRules: importedRotationRuleList,
      memos: importedMemos,
      completionHistory: importedHistory,
      lastResetDate: importedLastReset,
      userSettings: importedUserSettings,
      ankiSettings: importedAnkiSettings,
      memoTags: importedMemoTags
    }
}

/**
 * 原子地把已归一化的数据写入 LocalStorage。
 * 任意写入失败都会回滚前序写入，确保本地不被损坏的数据污染。
 * 返回标准化结果，失败返回 null。
 */
export function persistBackupToStorage(payload, { fallbackLastReset = '' } = {}) {
  try {
    const normalized = normalizeBackupPayload(payload, { fallbackLastReset })

    const prevSnapshots = {}
    for (const [domain, key] of Object.entries(STORAGE_KEYS_FOR_IMPORT)) {
      prevSnapshots[domain] = localStorage.getItem(key)
    }

    const rollbackAll = () => {
      for (const [domain, prev] of Object.entries(prevSnapshots)) {
        const key = STORAGE_KEYS_FOR_IMPORT[domain]
        if (prev == null) safeStorageRemove(key)
        else localStorage.setItem(key, prev)
      }
    }

    const writes = [
      ['workflows', () => safeStorageSet(STORAGE_KEYS_FOR_IMPORT.workflows, normalized.workflows)],
      ['rotationRules', () => safeStorageSet(STORAGE_KEYS_FOR_IMPORT.rotationRules, normalized.rotationRules)],
      ['memos', () => safeStorageSet(STORAGE_KEYS_FOR_IMPORT.memos, normalized.memos)],
      ['completionHistory', () => safeStorageSet(STORAGE_KEYS_FOR_IMPORT.completionHistory, normalized.completionHistory)],
      ['lastResetDate', () => safeStorageSet(STORAGE_KEYS_FOR_IMPORT.lastResetDate, normalized.lastResetDate)],
      ['userSettings', () => safeStorageSet(STORAGE_KEYS_FOR_IMPORT.userSettings, normalized.userSettings)],
      ['ankiSettings', () => safeStorageSet(STORAGE_KEYS_FOR_IMPORT.ankiSettings, normalized.ankiSettings)],
      ['memoTags', () => safeStorageSet(STORAGE_KEYS_FOR_IMPORT.memoTags, normalized.memoTags)],

    ]

    for (const [name, fn] of writes) {
      try {
        const ok = fn()
        if (!ok) {
          DBG('apply:write:fail', name)
          rollbackAll()
          return null
        }
      } catch (e) {
        DBG(`apply:${name}:error`, String(e))
        rollbackAll()
        return null
      }
    }

    DBG('apply:success', {
      workflowsLength: normalized.workflows.length,
      rotationRulesLength: normalized.rotationRules.length,
      memosLength: normalized.memos.length,
      historyDays: Object.keys(normalized.completionHistory).length,
      importedLastResetDate: normalized.lastResetDate,
      hasAnkiKey: Boolean(normalized.ankiSettings && normalized.ankiSettings.apiKey)
    })
    return normalized
  } catch (err) {
    DBG('apply:error', String(err?.stack || err))
    return null
  }
}

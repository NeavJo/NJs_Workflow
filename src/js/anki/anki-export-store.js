import {
  ANKI_EXPORT_SETTINGS_STORAGE_KEY,
  DEFAULT_ANKI_EXPORT_SETTINGS,
  normalizeAnkiExportSettings
} from '../config/storage-config.js'
import { safeStorageGet, safeStorageSet } from '../core/storage.js'
import { DBG } from '../core/debug.js'
import { createPubSub } from '../utils/pubsub.js'
import { requestAutoUpload } from '../core/sync-hooks.js'

// Anki APKG 导出配置状态源：按 memo 标签维护目标卡组与笔记类型，未配置时回落到默认配置。
// 设计约束：
//  1. 严格一致性：所有写操作先持久化，成功后才更新内存并 emit；失败则保持旧状态并返回 ok:false。
//  2. 配置跟随标签 ID：标签删除后其配置保留但不被展示，便于恢复旧标签时不丢配置。
//  3. 该 Store 不触发明文密钥同步，也不会调用 Gist 上传；备份/同步在后续阶段单独接入。

let ankiExportSettings = normalizeAnkiExportSettings(
  safeStorageGet(ANKI_EXPORT_SETTINGS_STORAGE_KEY, DEFAULT_ANKI_EXPORT_SETTINGS)
)

// 导出配置变更订阅：保存成功后通知设置页与处理机输出区刷新提示文案或按钮可用性。
const ankiExportPubsub = createPubSub()

/**
 * 订阅 APKG 导出配置变更，返回取消订阅函数。
 * @param {(data: object) => void} fn
 * @returns {() => void}
 */
export function onAnkiExportSettingsChange(fn) {
  return ankiExportPubsub.on(fn)
}

/**
 * 启动时重新装载本地配置；用于 app.js 初始化和外部导入后需要强制对齐时。
 */
export function loadAnkiExportSettings() {
  ankiExportSettings = normalizeAnkiExportSettings(
    safeStorageGet(ANKI_EXPORT_SETTINGS_STORAGE_KEY, DEFAULT_ANKI_EXPORT_SETTINGS)
  )
  DBG('init:ankiExportSettings', {
    tagConfigCount: Object.keys(ankiExportSettings.tagConfigs).length,
    defaultDeck: ankiExportSettings.defaultConfig.deckName,
    defaultModel: ankiExportSettings.defaultConfig.modelName
  })
  return ankiExportSettings
}

/**
 * 获取当前导出配置（只读语义；调用方不可直接修改返回对象）。
 */
export function getAnkiExportSettings() {
  return ankiExportSettings
}

/**
 * 纯内存 setter：仅供备份恢复与 Gist 导入使用；这些流程会另行持久化，不纳入本 Store 的 commit 路径。
 * 注意：调用方在 set 之后必须调用 persistAnkiExportSettings() 显式落盘，
 * 否则刷新页面后配置会丢失（Gist 拉取路径曾因此丢失 ankiExportSettings）。
 */
export function setAnkiExportSettings(next, { emit = true, source = 'export-settings:set' } = {}) {
  ankiExportSettings = normalizeAnkiExportSettings(next)
  if (emit) {
    ankiExportPubsub.emit({
      settings: ankiExportSettings,
      reason: source
    })
  }
  return ankiExportSettings
}

/**
 * 显式落盘：把当前内存镜像写入 localStorage 并触发自动上传。
 * 与 commitAnkiExportSettings 区分：本函数不改变内存状态、不 emit，
 * 仅用于外部导入（Gist 拉取、备份恢复）已经把内存对齐后的持久化收尾。
 */
export function persistAnkiExportSettings() {
  const ok = safeStorageSet(ANKI_EXPORT_SETTINGS_STORAGE_KEY, ankiExportSettings)
  DBG('persist:ankiExportSettings', {
    ok,
    tagConfigCount: Object.keys(ankiExportSettings.tagConfigs).length,
    defaultDeck: ankiExportSettings.defaultConfig.deckName,
    defaultModel: ankiExportSettings.defaultConfig.modelName
  })
  if (ok) requestAutoUpload()
  return ok
}

/**
 * 按标签 ID 取配置；未配置时返回 defaultConfig，调用方可据此判断是否需要提示先配置。
 */
export function getAnkiExportTagConfig(tagId) {
  const id = String(tagId || '').trim()
  if (id && ankiExportSettings.tagConfigs[id]) {
    return ankiExportSettings.tagConfigs[id]
  }
  return ankiExportSettings.defaultConfig
}

/**
 * 判断某标签是否被显式配置（存在 tagConfigs 条目）。
 * 用于导出前区分"已单独配置"与"回落默认配置"，以便给出对应提示。
 */
export function hasAnkiExportTagConfig(tagId) {
  const id = String(tagId || '').trim()
  return Boolean(id && ankiExportSettings.tagConfigs[id])
}

/**
 * 严格一致性提交：先写 localStorage；成功后更新内存并 emit。
 * 失败时保留旧配置，避免设置页出现"已保存但未落盘"的假成功。
 */
export function commitAnkiExportSettings(next, { reason = 'export-settings:commit' } = {}) {
  const candidate = normalizeAnkiExportSettings(next)
  const ok = safeStorageSet(ANKI_EXPORT_SETTINGS_STORAGE_KEY, candidate)
  DBG('anki-export:commit', {
    reason,
    ok,
    tagConfigCount: Object.keys(candidate.tagConfigs).length
  })
  if (!ok) {
    return { ok: false, settings: ankiExportSettings }
  }
  ankiExportSettings = candidate
  ankiExportPubsub.emit({
    settings: ankiExportSettings,
    reason
  })
  return { ok: true, settings: ankiExportSettings }
}

/**
 * 获取当前选中 memo 标签对应的导出配置；tagId 由调用方从 memo-store 取得。
 * 未配置标签不会抛错，而是返回默认配置，保证 APKG 导出始终有可导入目标。
 */
export function getAnkiExportConfigForTag(tagId) {
  return getAnkiExportTagConfig(tagId)
}

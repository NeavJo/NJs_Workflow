import {
  DEFAULT_GIST_SETTINGS,
  normalizeGistSettings,
  normalizeUserSettings,
  GIST_SETTINGS_STORAGE_KEY
} from '../config.js'
import { safeStorageGet, safeStorageSet } from './storage.js'
import { DBG } from './debug.js'
import { getFullTimestamp } from './date.js'

export const DEFAULT_USER_SETTINGS = Object.freeze({})

export const USER_SETTINGS_STORAGE_KEY = 'njs-workflow-user-settings'

let userSettings = normalizeUserSettings(safeStorageGet(USER_SETTINGS_STORAGE_KEY, null))

export function getUserSettings() {
  return userSettings
}

export function setUserSettings(next) {
  userSettings = normalizeUserSettings(next)
  return userSettings
}

export function persistUserSettings() {
  const ok = safeStorageSet(USER_SETTINGS_STORAGE_KEY, userSettings)
  DBG('persist:userSettings', { size: Object.keys(userSettings).length, ok })
  return ok
}

let gistSettings = normalizeGistSettings(safeStorageGet(GIST_SETTINGS_STORAGE_KEY, DEFAULT_GIST_SETTINGS))

export function getGistSettings() {
  return gistSettings
}

export function setGistSettings(next) {
  gistSettings = normalizeGistSettings(next)
  return gistSettings
}

/**
 * 从 localStorage 重新载入 Gist 设置（尤其是 lastGistUpdatedAt 基线）。
 * 场景：同一浏览器的多个标签页共享 localStorage，但各自持有独立的内存副本。
 * 另一个标签页完成同步后会更新共享的 lastGistUpdatedAt；本标签页若不重读，
 * 就会用陈旧基线做冲突检测，可能把「对方已写入」误判为无冲突而盲目覆盖。
 * 因此在跨标签页锁内、真正操作前调用本函数，保证基线取到共享的最新值。
 */
export function reloadGistSyncBaselineFromStorage() {
  const stored = normalizeGistSettings(safeStorageGet(GIST_SETTINGS_STORAGE_KEY, DEFAULT_GIST_SETTINGS))
  gistSettings.lastGistUpdatedAt = stored.lastGistUpdatedAt || ''
  DBG('gist:settings:baseline-reloaded', { lastGistUpdatedAt: gistSettings.lastGistUpdatedAt })
  return gistSettings.lastGistUpdatedAt
}

export function persistGistSettings() {
  const ok = safeStorageSet(GIST_SETTINGS_STORAGE_KEY, gistSettings)
  DBG('persist:gistSettings', {
    hasToken: Boolean(gistSettings.token),
    gistId: gistSettings.gistId,
    lastSyncAction: gistSettings.lastSyncAction,
    lastSyncTime: gistSettings.lastSyncTime,
    lastGistUpdatedAt: gistSettings.lastGistUpdatedAt,
    ok
  })
  return ok
}

/**
 * 记录一次成功同步。
 *  - lastSyncTime 用设备本地时间，仅用于 UI 展示「上次同步时间」
 *  - lastGistUpdatedAt 记录本次操作对应的 Gist 服务端版本（updated_at），
 *    作为下一次冲突检测的比较基准。写入时必须与本次请求实际观察到的
 *    服务端版本一致，否则会误判（写旧值→下次重复触发冲突）。
 */
export function markGistSyncSuccess(action, { gistUpdatedAt = '' } = {}) {
  gistSettings.lastSyncAction = action
  gistSettings.lastSyncTime = getFullTimestamp()
  if (typeof gistUpdatedAt === 'string' && gistUpdatedAt) {
    gistSettings.lastGistUpdatedAt = gistUpdatedAt
  }
  persistGistSettings()
  DBG('gist:sync:mark', {
    action,
    time: gistSettings.lastSyncTime,
    gistUpdatedAt: gistSettings.lastGistUpdatedAt
  })
}

export function getLastGistUpdatedAt() {
  return gistSettings.lastGistUpdatedAt || ''
}

export function hasGistCredentials() {
  return Boolean(gistSettings.token && gistSettings.gistId)
}

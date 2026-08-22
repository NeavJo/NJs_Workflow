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

export function persistGistSettings() {
  const ok = safeStorageSet(GIST_SETTINGS_STORAGE_KEY, gistSettings)
  DBG('persist:gistSettings', {
    hasToken: Boolean(gistSettings.token),
    gistId: gistSettings.gistId,
    lastSyncAction: gistSettings.lastSyncAction,
    lastSyncTime: gistSettings.lastSyncTime,
    ok
  })
  return ok
}

export function markGistSyncSuccess(action) {
  gistSettings.lastSyncAction = action
  gistSettings.lastSyncTime = getFullTimestamp()
  persistGistSettings()
  DBG('gist:sync:mark', { action, time: gistSettings.lastSyncTime })
}

export function hasGistCredentials() {
  return Boolean(gistSettings.token && gistSettings.gistId)
}

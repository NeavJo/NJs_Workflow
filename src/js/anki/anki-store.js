import {
  DEFAULT_ANKI_SETTINGS,
  normalizeAnkiSettings,
  ANKI_SETTINGS_STORAGE_KEY
} from '../config/storage-config.js'
import { safeStorageGet, safeStorageSet } from '../core/storage.js'
import { DBG } from '../core/debug.js'
import { requestAutoUpload } from '../core/sync-hooks.js'

/**
 * Anki 处理机配置状态源：apiType / baseUrl / modelId / apiKey / apiKeyEncrypted / prompt。
 *  - apiKey 明文仅存于内存与 localStorage 供运行时调用模型 API；
 *    上传 Gist / 导出备份时由加密模块以对称密文（apiKeyEncrypted）写入，绝不出现明文。
 *  - persistAnkiSettings 调用 requestAutoUpload()，使配置变更随全局数据同步至 Gist。
 */

let ankiSettings = normalizeAnkiSettings(safeStorageGet(ANKI_SETTINGS_STORAGE_KEY, DEFAULT_ANKI_SETTINGS))

export function loadAnkiSettings() {
  ankiSettings = normalizeAnkiSettings(safeStorageGet(ANKI_SETTINGS_STORAGE_KEY, DEFAULT_ANKI_SETTINGS))
  DBG('init:ankiSettings', {
    apiType: ankiSettings.apiType,
    hasBaseUrl: Boolean(ankiSettings.baseUrl),
    modelId: ankiSettings.modelId,
    hasKey: Boolean(ankiSettings.apiKey),
    hasEncryptedKey: Boolean(ankiSettings.apiKeyEncrypted),
    hasCustomPrompt: Boolean(ankiSettings.prompt)
  })
  return ankiSettings
}

export function getAnkiSettings() {
  return ankiSettings
}

export function setAnkiSettings(next) {
  ankiSettings = normalizeAnkiSettings(next)
  return ankiSettings
}

export function persistAnkiSettings() {
  const ok = safeStorageSet(ANKI_SETTINGS_STORAGE_KEY, ankiSettings)
  DBG('persist:ankiSettings', {
    apiType: ankiSettings.apiType,
    hasBaseUrl: Boolean(ankiSettings.baseUrl),
    modelId: ankiSettings.modelId,
    hasKey: Boolean(ankiSettings.apiKey),
    hasEncryptedKey: Boolean(ankiSettings.apiKeyEncrypted),
    hasCustomPrompt: Boolean(ankiSettings.prompt),
    ok
  })
  requestAutoUpload()
  return ok
}

export function hasAnkiCredentials() {
  return Boolean(ankiSettings.apiKey && ankiSettings.modelId && ankiSettings.baseUrl)
}

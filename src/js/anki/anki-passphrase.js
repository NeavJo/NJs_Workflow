import { safeStorageGet, safeStorageSet, safeStorageRemove } from '../core/storage.js'
import { DBG } from '../core/debug.js'

/**
 * Anki API Key 加密口令的生命周期管理：
 *  - sessionPassphrase：当前会话解锁后持有，仅存内存；刷新页面后按需重新解锁。
 *  - 可选"记住口令"：写入 localStorage，下次启动自动解锁（仅保存在本设备，不会上传 Gist / 不进入备份）。
 *  - 口令仅用于 AES-GCM 加解密 API Key；密文载荷本身不携带口令。
 */

export const ANKI_PASSPHRASE_STORAGE_KEY = 'njs-workflow-anki-passphrase'

let sessionPassphrase = ''

function loadRemembered() {
  const v = safeStorageGet(ANKI_PASSPHRASE_STORAGE_KEY, '')
  return typeof v === 'string' ? v : ''
}

export function getSessionPassphrase() {
  return sessionPassphrase
}

export function isPassphraseUnlocked() {
  return Boolean(sessionPassphrase)
}

export function hasRememberedPassphrase() {
  return Boolean(loadRemembered())
}

export function getEffectivePassphrase() {
  if (sessionPassphrase) return sessionPassphrase
  return loadRemembered()
}

export function setPassphrase(passphrase, { remember = false } = {}) {
  const p = typeof passphrase === 'string' ? passphrase : ''
  if (!p) return false
  sessionPassphrase = p
  if (remember) {
    if (!safeStorageSet(ANKI_PASSPHRASE_STORAGE_KEY, p)) {
      DBG('anki:passphrase:remember:fail')
      return false
    }
  } else {
    safeStorageRemove(ANKI_PASSPHRASE_STORAGE_KEY)
  }
  DBG('anki:passphrase:set', { remember, unlocked: Boolean(sessionPassphrase) })
  return true
}

export function clearPassphrase() {
  sessionPassphrase = ''
  safeStorageRemove(ANKI_PASSPHRASE_STORAGE_KEY)
  DBG('anki:passphrase:clear')
}

export function unlockFromRemembered() {
  const remembered = loadRemembered()
  if (!remembered) return false
  sessionPassphrase = remembered
  DBG('anki:passphrase:auto-unlock')
  return true
}

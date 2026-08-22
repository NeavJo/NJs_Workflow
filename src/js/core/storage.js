import { DBG } from './debug.js'

export const COMPLETED_STORAGE_KEY = 'njs-workflow-completed'
export const MEMO_STORAGE_KEY = 'njs-workflow-memos'

export function safeStorageGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return fallback
    return JSON.parse(raw)
  } catch (err) {
    DBG('storage:get:error', { key, err: String(err) })
    return fallback
  }
}

export function safeStorageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch (err) {
    DBG('storage:set:error', { key, err: String(err) })
    return false
  }
}

export function safeStorageRemove(key) {
  try {
    localStorage.removeItem(key)
    return true
  } catch (err) {
    DBG('storage:remove:error', { key, err: String(err) })
    return false
  }
}

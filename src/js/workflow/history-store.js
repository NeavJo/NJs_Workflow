import {
  COMPLETION_HISTORY_STORAGE_KEY,
  LAST_RESET_DATE_STORAGE_KEY,
  normalizeCompletionHistory
} from '../config/storage-config.js'
import { safeStorageGet, safeStorageSet } from '../core/storage.js'
import { DBG } from '../core/debug.js'
import { getTodayDateString } from '../core/date.js'
import { getCompletedIds, setCompletedIds, persistCompleted, clearCompleted } from './completion-store.js'
import { requestAutoUpload } from '../core/sync-hooks.js'

let completionHistory = {}
let lastResetDate = ''

const historyListeners = new Set()

function emitHistoryChange() {
  for (const fn of historyListeners) {
    try { fn({ history: completionHistory, lastResetDate }) } catch (e) { DBG('history:listener:error', String(e)) }
  }
}

export function loadCompletionHistory() {
  completionHistory = normalizeCompletionHistory(safeStorageGet(COMPLETION_HISTORY_STORAGE_KEY, {}))
  return completionHistory
}

export function getCompletionHistory() {
  return completionHistory
}

export function setCompletionHistory(next) {
  completionHistory = next && typeof next === 'object' && !Array.isArray(next) ? { ...next } : {}
  return completionHistory
}

export function persistCompletionHistory() {
  const ok = safeStorageSet(COMPLETION_HISTORY_STORAGE_KEY, completionHistory)
  DBG('persist:completionHistory', {
    days: Object.keys(completionHistory).length,
    total: Object.values(completionHistory).reduce((acc, arr) => acc + arr.length, 0),
    ok
  })
  requestAutoUpload()
  return ok
}

export function loadLastResetDate() {
  const raw = safeStorageGet(LAST_RESET_DATE_STORAGE_KEY, '')
  lastResetDate = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : ''
  return lastResetDate
}

export function getLastResetDate() {
  return lastResetDate
}

export function setLastResetDate(value) {
  lastResetDate = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ''
  return lastResetDate
}

export function persistLastResetDate() {
  const ok = safeStorageSet(LAST_RESET_DATE_STORAGE_KEY, lastResetDate)
  DBG('persist:lastResetDate', { value: lastResetDate, ok })
  return ok
}

export function archiveTodayToHistory(dateStr) {
  const date = dateStr || lastResetDate || getTodayDateString()
  if (!date) return false
  const currentIds = [...getCompletedIds()]
  if (currentIds.length === 0) {
    DBG('archive:noop', { date })
    return false
  }
  const prev = Array.isArray(completionHistory[date]) ? completionHistory[date] : []
  const merged = [...new Set([...prev, ...currentIds])]
  if (merged.length === prev.length) {
    DBG('archive:no-new', { date, prev: prev.length })
    return false
  }
  completionHistory = { ...completionHistory, [date]: merged }
  return true
}

export function performDailyReset({ silent = false, onComplete } = {}) {
  const today = getTodayDateString()
  const archivedDate = lastResetDate || today
  const archived = archiveTodayToHistory(archivedDate)
  if (archived) persistCompletionHistory()

  const before = getCompletedIds().size
  clearCompleted()
  lastResetDate = today
  persistLastResetDate()
  emitHistoryChange()
  DBG('reset:daily', { today, archivedDate, archived, cleared: before })
  if (typeof onComplete === 'function') {
    try { onComplete({ today, archivedDate, archived, cleared: before, silent }) } catch (e) { DBG('reset:onComplete:error', String(e)) }
  }
  return { today, archivedDate, archived, cleared: before, silent }
}

export function checkDailyReset({ force = false, reason = 'init', onComplete } = {}) {
  const today = getTodayDateString()
  if (!force && today === lastResetDate) return false
  DBG('reset:check', { reason, today, lastResetDate })
  return performDailyReset({ silent: reason === 'silent', onComplete })
}

export function restoreTodayCompletedFromHistory() {
  const todayStr = getTodayDateString()
  const todayIds = Array.isArray(completionHistory[todayStr]) ? completionHistory[todayStr] : []
  if (todayIds.length === 0) {
    DBG('restore:today-completed:empty', { today: todayStr })
    return false
  }
  setCompletedIds(todayIds)
  persistCompleted()
  DBG('restore:today-completed:ok', { today: todayStr, count: todayIds.length })
  return true
}

export function onHistoryChange(fn) {
  historyListeners.add(fn)
  return () => historyListeners.delete(fn)
}

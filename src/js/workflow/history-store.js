import {
  COMPLETION_HISTORY_STORAGE_KEY,
  LAST_RESET_DATE_STORAGE_KEY,
  normalizeCompletionHistory
} from '../config/storage-config.js'
import { safeStorageGet, safeStorageSet } from '../core/storage.js'
import { DBG } from '../core/debug.js'
import { getTodayDateString } from '../core/date.js'
import { getCompletedIds, setCompletedIds, persistCompleted, clearCompleted } from './completion-store.js'
import { getTrackableTasks } from './workflow-runtime.js'
import { requestAutoUpload } from '../core/sync-hooks.js'
import { createPubSub } from '../utils/pubsub.js'

let completionHistory = {}
let lastResetDate = ''

const pubsub = createPubSub()

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
    total: Object.values(completionHistory).reduce((acc, record) => {
      const ids = record && Array.isArray(record.completedIds) ? record.completedIds.length : 0
      return acc + ids
    }, 0),
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

function toDateObject(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function archiveTodayToHistory(dateStr) {
  const date = dateStr || lastResetDate || getTodayDateString()
  if (!date) return false
  const currentIds = [...getCompletedIds()]
  const prevRecord = completionHistory[date]
  const prevIds = prevRecord && Array.isArray(prevRecord.completedIds) ? prevRecord.completedIds : []
  const merged = [...new Set([...prevIds, ...currentIds])]
  // 0 完成也要保存 totalTasks 快照：旧早退逻辑会让“无完成日”缺失分母
  if (currentIds.length === 0 && prevIds.length === 0) {
    DBG('archive:noop', { date })
    return false
  }
  const hasNewIds = merged.length > prevIds.length
  // 同日后续归档不覆盖首次锁定的 totalTasks；无新增且已有快照时保持幂等不重写
  if (!hasNewIds && typeof prevRecord?.totalTasks === 'number') {
    DBG('archive:no-new', { date, prev: prevIds.length })
    return false
  }
  let totalTasks = typeof prevRecord?.totalTasks === 'number' ? prevRecord.totalTasks : null
  if (totalTasks === null) {
    totalTasks = getTrackableTasks(toDateObject(date)).length
  }
  completionHistory = { ...completionHistory, [date]: { completedIds: merged, totalTasks } }
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
  pubsub.emit(completionHistory)
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
  const record = completionHistory[todayStr]
  const todayIds = record && Array.isArray(record.completedIds) ? record.completedIds : []
  setCompletedIds(todayIds)
  persistCompleted()
  if (todayIds.length === 0) {
    DBG('restore:today-completed:empty', { today: todayStr })
    return false
  }
  DBG('restore:today-completed:ok', { today: todayStr, count: todayIds.length })
  return true
}

export function onHistoryChange(fn) {
  return pubsub.on(fn)
}

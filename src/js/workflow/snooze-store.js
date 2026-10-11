import { SNOOZE_STORAGE_KEY, normalizeSnoozeRecords } from '../config/storage-config.js'
import { getTodayDateString } from '../core/date.js'
import { safeStorageGet, safeStorageSet } from '../core/storage.js'
import { createPubSub } from '../utils/pubsub.js'
import { getWorkflows } from './workflow-store.js'
import { getCompletedIds } from './completion-store.js'
import { isTaskTrackable } from './workflow-runtime.js'

let state = { version: 1, records: {} }
const changes = createPubSub()

export function getSnoozeRecords() {
  return state.records
}

export function getSnoozeRecord(date = getTodayDateString()) {
  return state.records[date] || null
}

export function getSnoozedIds(date = getTodayDateString()) {
  return new Set(getSnoozeRecord(date)?.taskIds || [])
}

export function isTaskSnoozed(taskId, date = getTodayDateString()) {
  return getSnoozedIds(date).has(taskId)
}

export function onSnoozeChange(callback) {
  return changes.on(callback)
}

export function loadSnoozeRecords() {
  state = normalizeSnoozeRecords(safeStorageGet(SNOOZE_STORAGE_KEY, { version: 1, records: {} }))
  return state.records
}

export function setSnoozeRecords(raw, { emit = true, source = 'local' } = {}) {
  state = normalizeSnoozeRecords(raw)
  if (emit) changes.emit({ records: state.records, source })
  return state.records
}

export function persistSnoozeRecords() {
  return safeStorageSet(SNOOZE_STORAGE_KEY, state)
}

export function saveTodaySnoozeSelection(taskIds, reason = '') {
  const date = getTodayDateString()
  const completedIds = getCompletedIds()
  const workflows = getWorkflows()
  const requestedIds = new Set(Array.isArray(taskIds) ? taskIds.filter((id) => typeof id === 'string') : [])
  const taskSnapshots = workflows
    .filter((task) => requestedIds.has(task.id) && !task.isPlaceholder && !completedIds.has(task.id) && isTaskTrackable(task))
    .map((task) => ({ id: task.id, title: task.title }))
  const nextRecords = { ...state.records }

  if (taskSnapshots.length === 0) {
    delete nextRecords[date]
  } else {
    nextRecords[date] = {
      taskIds: taskSnapshots.map((task) => task.id),
      taskSnapshots,
      reason: typeof reason === 'string' ? reason.trim().slice(0, 240) : '',
      updatedAt: Date.now()
    }
  }

  const nextState = normalizeSnoozeRecords({ version: 1, records: nextRecords })
  if (!safeStorageSet(SNOOZE_STORAGE_KEY, nextState)) return false
  state = nextState
  changes.emit({ records: state.records, date, source: 'local' })
  return true
}

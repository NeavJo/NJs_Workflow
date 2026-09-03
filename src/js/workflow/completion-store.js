import { COMPLETED_STORAGE_KEY } from '../core/storage.js'
import { safeStorageGet, safeStorageSet } from '../core/storage.js'
import { DBG } from '../core/debug.js'
import { getWorkflows } from './workflow-store.js'
import { requestAutoUpload } from '../core/sync-hooks.js'
import { createPubSub } from '../utils/pubsub.js'

const completedItems = new Set()
const pubsub = createPubSub()

function normalizeCompletedIds(rawList) {
  if (!Array.isArray(rawList)) return []
  const workflows = getWorkflows()
  const validIdSet = new Set(workflows.map((t) => t.id))
  const ids = rawList.map((item) => {
    if (typeof item === 'string') return item
    if (!item || typeof item !== 'object') return null
    if (item.completed === false) return null
    return item.id || item.taskId || item.workflowId || null
  }).filter((id) => typeof id === 'string' && validIdSet.has(id))
  return [...new Set(ids)]
}

export function loadCompleted() {
  const raw = safeStorageGet(COMPLETED_STORAGE_KEY, [])
  const ids = normalizeCompletedIds(raw)
  completedItems.clear()
  ids.forEach((id) => completedItems.add(id))
  return completedItems
}

export function getCompletedIds() {
  return new Set(completedItems)
}

export function hasCompleted(id) {
  return completedItems.has(id)
}

export function setCompletedIds(ids) {
  completedItems.clear()
  for (const id of ids) completedItems.add(id)
  pubsub.emit(new Set(completedItems))
}

export function persistCompleted() {
  const snapshot = [...completedItems]
  const ok = safeStorageSet(COMPLETED_STORAGE_KEY, snapshot)
  DBG('persist:completed', { size: completedItems.size, ok })
  requestAutoUpload()
  return ok
}

export function toggleCompleted(id, { forced = false } = {}) {
  if (completedItems.has(id)) {
    completedItems.delete(id)
  } else {
    completedItems.add(id)
  }
  persistCompleted()
  pubsub.emit(new Set(completedItems))
  return completedItems.has(id)
}

export function addCompleted(id) {
  if (completedItems.has(id)) return false
  completedItems.add(id)
  persistCompleted()
  pubsub.emit(new Set(completedItems))
  return true
}

export function removeCompleted(id) {
  if (!completedItems.has(id)) return false
  completedItems.delete(id)
  persistCompleted()
  pubsub.emit(new Set(completedItems))
  return true
}

export function clearCompleted() {
  completedItems.clear()
  persistCompleted()
  pubsub.emit(new Set(completedItems))
}

export function pruneCompleted(validIds) {
  let changed = false
  for (const id of [...completedItems]) {
    if (!validIds.has(id)) {
      completedItems.delete(id)
      changed = true
    }
  }
  if (changed) {
    persistCompleted()
    pubsub.emit(new Set(completedItems))
  }
  return changed
}

export function onCompletedChange(fn) {
  return pubsub.on(fn)
}

import {
  DEFAULT_WORKFLOWS,
  normalizeTask,
  createTask
} from '../config/workflow-config.js'
import { DBG } from '../core/debug.js'
import { WORKFLOWS_STORAGE_KEY } from '../config/storage-config.js'
import { safeStorageGet, safeStorageSet } from '../core/storage.js'
import { requestAutoUpload } from '../core/sync-hooks.js'
import { createPubSub } from '../utils/pubsub.js'

let workflows = []
const pubsub = createPubSub()

function migrateKnownTasks(tasks) {
  for (const def of DEFAULT_WORKFLOWS) {
    const stored = tasks.find((t) => t.id === def.id)
    if (!stored) continue
    if (!def.isPlaceholder && stored.isPlaceholder) {
      stored.isPlaceholder = false
    }
    if (def.checkConfig && !stored.checkConfig) {
      stored.checkConfig = { ...def.checkConfig }
    }
    if (typeof stored.desc === 'string' && stored.desc.startsWith('⚠️ 暂未开放')) {
      stored.desc = def.desc
    }
  }
  // 确保所有任务都有 prerequisites 字段
  for (const t of tasks) {
    if (!Array.isArray(t.prerequisites)) t.prerequisites = []
  }
}

export function serializeWorkflowArray(list) {
  return list.map((t) => ({
    id: t.id,
    title: t.title,
    desc: t.desc || null,
    url: t.url || null,
    type: t.type || (t.url ? 'jump_and_check' : 'check_only'),
    isPlaceholder: Boolean(t.isPlaceholder),
    hasDynamicTag: Boolean(t.hasDynamicTag || t.rotationRuleId),
    rotationRuleId: t.rotationRuleId || null,
    checkConfig: t.checkConfig || null,
    prerequisites: Array.isArray(t.prerequisites) ? t.prerequisites.filter(Boolean) : []
  }))
}

export function loadWorkflows() {
  const raw = safeStorageGet(WORKFLOWS_STORAGE_KEY, null)
  if (Array.isArray(raw) && raw.length > 0) {
    const normalized = raw.map(normalizeTask).filter(Boolean)
    if (normalized.length > 0) {
      migrateKnownTasks(normalized)
      DBG('init:workflows:from-storage', { count: normalized.length })
      workflows = normalized
      return workflows
    }
  }
  DBG('init:workflows:from-default', { count: DEFAULT_WORKFLOWS.length })
  workflows = DEFAULT_WORKFLOWS.map((t) => normalizeTask({ ...t })).filter(Boolean)
  return workflows
}

export function getWorkflows() {
  return workflows
}

export function setWorkflows(next) {
  workflows = Array.isArray(next) ? next.map(normalizeTask).filter(Boolean) : []
  pubsub.emit(workflows)
  return workflows
}

export function persistWorkflows() {
  const snapshot = serializeWorkflowArray(workflows)
  const ok = safeStorageSet(WORKFLOWS_STORAGE_KEY, snapshot)
  DBG('persist:workflows', { size: workflows.length, ok })
  requestAutoUpload()
  return ok
}

export function persistWorkflowsAndRender(afterPersist) {
  const ok = persistWorkflows()
  pubsub.emit(workflows)
  try { afterPersist(workflows) } catch (e) { DBG('workflow:afterPersist:error', String(e)) }
  return ok
}

export function addTask(overrides) {
  const task = createTask(overrides || {})
  workflows.push(task)
  persistWorkflows()
  pubsub.emit(workflows)
  return task
}

export function updateTask(id, patch) {
  const idx = workflows.findIndex((t) => t.id === id)
  if (idx === -1) return null
  workflows[idx] = { ...workflows[idx], ...patch }
  persistWorkflows()
  pubsub.emit(workflows)
  return workflows[idx]
}

export function replaceTask(id, next) {
  const idx = workflows.findIndex((t) => t.id === id)
  if (idx === -1) return null
  workflows[idx] = next
  persistWorkflows()
  pubsub.emit(workflows)
  return workflows[idx]
}

export function removeTask(id) {
  const before = workflows.length
  workflows = workflows.filter((t) => t.id !== id)
  if (workflows.length !== before) {
    persistWorkflows()
    pubsub.emit(workflows)
  }
  return workflows
}

export function moveTask(id, direction) {
  const i = workflows.findIndex((t) => t.id === id)
  if (i === -1) return false
  if (direction === 'up' && i === 0) return false
  if (direction === 'down' && i === workflows.length - 1) return false
  const j = direction === 'up' ? i - 1 : i + 1
  ;[workflows[i], workflows[j]] = [workflows[j], workflows[i]]
  persistWorkflows()
  pubsub.emit(workflows)
  return true
}

export function resetToDefaults() {
  workflows = DEFAULT_WORKFLOWS.map((t) => normalizeTask({ ...t })).filter(Boolean)
  persistWorkflows()
  pubsub.emit(workflows)
  return workflows
}

export function replaceAll(next) {
  workflows = Array.isArray(next) ? next.map(normalizeTask).filter(Boolean) : []
  pubsub.emit(workflows)
  return workflows
}

export function onWorkflowsChange(fn) {
  return pubsub.on(fn)
}

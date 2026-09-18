import {
  DEFAULT_ROTATION_RULES,
  ROTATION_RULES_STORAGE_KEY,
  normalizeRotationRuleList
} from '../config/rotation-rules.js'
import { safeStorageGet, safeStorageSet } from '../core/storage.js'
import { DBG } from '../core/debug.js'
import { requestAutoUpload } from '../core/sync-hooks.js'
import { createPubSub } from '../utils/pubsub.js'

let rotationRules = []
const pubsub = createPubSub()

function deepCopyRule(rule) {
  return JSON.parse(JSON.stringify(rule))
}

export function loadRotationRules() {
  const raw = safeStorageGet(ROTATION_RULES_STORAGE_KEY, null)
  const normalized = normalizeRotationRuleList(raw)
  const defaults = normalizeRotationRuleList(deepCopyRule(DEFAULT_ROTATION_RULES))
  const merged = [...normalized]
  for (const d of defaults) {
    if (!merged.find((r) => r.id === d.id)) merged.push(d)
  }
  DBG('init:rotationRules', { count: merged.length, ids: merged.map(r => r.id) })
  rotationRules = merged
  return rotationRules
}

export function getRotationRules() {
  return rotationRules
}

export function setRotationRules(next) {
  rotationRules = normalizeRotationRuleList(next)
  pubsub.emit(rotationRules)
  return rotationRules
}

export function persistRotationRules() {
  const snapshot = deepCopyRule(rotationRules)
  const ok = safeStorageSet(ROTATION_RULES_STORAGE_KEY, snapshot)
  DBG('persist:rotationRules', { size: rotationRules.length, ok })
  requestAutoUpload()
  return ok
}

export function findRotationRule(id) {
  if (!id) return null
  return rotationRules.find((r) => r.id === id) || null
}

export function upsertRotationRule(rule) {
  const clean = deepCopyRule(rule)
  const idx = rotationRules.findIndex((r) => r.id === clean.id)
  if (idx === -1) rotationRules.push(clean)
  else rotationRules[idx] = clean
  persistRotationRules()
  pubsub.emit(rotationRules)
  return clean.id
}

export function detachRotationRuleFromTasks(ruleId) {
  return (workflows) => workflows.map((t) => {
    if (t.rotationRuleId === ruleId) {
      return { ...t, rotationRuleId: null, hasDynamicTag: false }
    }
    return t
  })
}

export function deleteRotationRule(ruleId) {
  rotationRules = rotationRules.filter((r) => r.id !== ruleId)
  persistRotationRules()
  pubsub.emit(rotationRules)
  return rotationRules
}

export function onRotationRulesChange(fn) {
  return pubsub.on(fn)
}

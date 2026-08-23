/**
 * 增强版工作流 Store - 基于 BaseStore
 * -----------------------------------------------------------------------------
 * 继承自 BaseStore，提供工作流数据的统一管理。
 * 保持与原有 WorkflowStore 的完全兼容性。
 */

import { BaseStore, createArrayStore } from '../core/base-store.js'
import {
  DEFAULT_WORKFLOWS,
  normalizeTask,
  createTask
} from '../config/workflow-config.js'
import { WORKFLOWS_STORAGE_KEY } from '../config/storage-config.js'
import { DBG } from '../core/debug.js'
import { requestAutoUpload } from '../core/sync-hooks.js'

/**
 * 增强版工作流 Store
 */
export class WorkflowStore extends BaseStore {
  constructor() {
    super(
      WORKFLOWS_STORAGE_KEY,
      DEFAULT_WORKFLOWS,
      (data) => this.normalizeWorkflowData(data)
    )
    this.changeListeners = new Set()
  }

  /**
   * 标准化工作流数据
   */
  normalizeWorkflowData(data) {
    if (!Array.isArray(data)) {
      DBG('workflow-store:invalid-data', { type: typeof data })
      return DEFAULT_WORKFLOWS.map(t => normalizeTask({ ...t })).filter(Boolean)
    }

    const normalized = data.map(normalizeTask).filter(Boolean)
    if (normalized.length > 0) {
      this.migrateKnownTasks(normalized)
      DBG('workflow-store:normalized', { count: normalized.length })
      return normalized
    }

    DBG('workflow-store:using-defaults', { count: DEFAULT_WORKFLOWS.length })
    return DEFAULT_WORKFLOWS.map(t => normalizeTask({ ...t })).filter(Boolean)
  }

  /**
   * 迁移已知任务
   */
  migrateKnownTasks(tasks) {
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
  }

  /**
   * 序列化工作流数组
   */
  serializeWorkflowArray(list) {
    return list.map((t) => ({
      id: t.id,
      title: t.title,
      desc: t.desc || null,
      url: t.url || null,
      type: t.type || (t.url ? 'jump_and_check' : 'check_only'),
      isPlaceholder: Boolean(t.isPlaceholder),
      hasDynamicTag: Boolean(t.hasDynamicTag || t.rotationRuleId),
      rotationRuleId: t.rotationRuleId || null,
      checkConfig: t.checkConfig || null
    }))
  }

  /**
   * 加载工作流数据（保持兼容性）
   */
  loadWorkflows() {
    const result = this.load()
    DBG('workflow-store:loaded', { count: result.length })
    return result
  }

  /**
   * 获取工作流数据（保持兼容性）
   */
  getWorkflows() {
    return this.getState()
  }

  /**
   * 设置工作流数据（保持兼容性）
   */
  setWorkflows(next) {
    this.updateState(Array.isArray(next) ? next : [])
    this.emitChange()
    return this.getState()
  }

  /**
   * 持久化工作流数据（保持兼容性）
   */
  persistWorkflows() {
    const snapshot = this.serializeWorkflowArray(this.getState())
    const ok = this.persist()
    DBG('workflow-store:persisted', { size: snapshot.length, ok })
    requestAutoUpload()
    return ok
  }

  /**
   * 持久化并触发渲染（保持兼容性）
   */
  persistWorkflowsAndRender(afterPersist) {
    const ok = this.persistWorkflows()
    this.emitChange()
    if (typeof afterPersist === 'function') {
      try { afterPersist(this.getState()) } catch (e) { DBG('workflow:afterPersist:error', String(e)) }
    }
    return ok
  }

  /**
   * 添加任务（保持兼容性）
   */
  addTask(overrides) {
    const task = createTask(overrides || {})
    const current = this.getState()
    current.push(task)
    this.updateState(current)
    this.persistWorkflows()
    this.emitChange()
    return task
  }

  /**
   * 更新任务（保持兼容性）
   */
  updateTask(id, patch) {
    const current = this.getState()
    const idx = current.findIndex((t) => t.id === id)
    if (idx === -1) return null
    current[idx] = { ...current[idx], ...patch }
    this.updateState(current)
    this.persistWorkflows()
    this.emitChange()
    return current[idx]
  }

  /**
   * 替换任务（保持兼容性）
   */
  replaceTask(id, next) {
    const current = this.getState()
    const idx = current.findIndex((t) => t.id === id)
    if (idx === -1) return null
    current[idx] = next
    this.updateState(current)
    this.persistWorkflows()
    this.emitChange()
    return current[idx]
  }

  /**
   * 移除任务（保持兼容性）
   */
  removeTask(id) {
    const current = this.getState()
    const before = current.length
    const filtered = current.filter((t) => t.id !== id)
    if (filtered.length !== before) {
      this.updateState(filtered)
      this.persistWorkflows()
      this.emitChange()
    }
    return filtered
  }

  /**
   * 移动任务（保持兼容性）
   */
  moveTask(id, direction) {
    const current = this.getState()
    const i = current.findIndex((t) => t.id === id)
    if (i === -1) return false
    if (direction === 'up' && i === 0) return false
    if (direction === 'down' && i === current.length - 1) return false
    const j = direction === 'up' ? i - 1 : i + 1
    ;[current[i], current[j]] = [current[j], current[i]]
    this.updateState(current)
    this.persistWorkflows()
    this.emitChange()
    return true
  }

  /**
   * 重置为默认值（保持兼容性）
   */
  resetToDefaults() {
    const normalized = DEFAULT_WORKFLOWS.map((t) => normalizeTask({ ...t })).filter(Boolean)
    this.updateState(normalized)
    this.persistWorkflows()
    this.emitChange()
    return normalized
  }

  /**
   * 替换所有任务（保持兼容性）
   */
  replaceAll(next) {
    this.updateState(Array.isArray(next) ? next : [])
    this.emitChange()
    return this.getState()
  }

  /**
   * 监听变化（保持兼容性）
   */
  onWorkflowsChange(fn) {
    this.changeListeners.add(fn)
    return () => this.changeListeners.delete(fn)
  }

  /**
   * 触发变化事件
   */
  emitChange() {
    for (const fn of this.changeListeners) {
      try { fn(this.getState()) } catch (e) { DBG('workflow:listener:error', String(e)) }
    }
  }
}

// 创建全局工作流 Store 实例
export const workflowStore = new WorkflowStore()

// 导出兼容性函数，保持与原有代码的兼容性
export function loadWorkflows() {
  return workflowStore.loadWorkflows()
}

export function getWorkflows() {
  return workflowStore.getWorkflows()
}

export function setWorkflows(next) {
  return workflowStore.setWorkflows(next)
}

export function persistWorkflows() {
  return workflowStore.persistWorkflows()
}

export function persistWorkflowsAndRender(afterPersist) {
  return workflowStore.persistWorkflowsAndRender(afterPersist)
}

export function addTask(overrides) {
  return workflowStore.addTask(overrides)
}

export function updateTask(id, patch) {
  return workflowStore.updateTask(id, patch)
}

export function replaceTask(id, next) {
  return workflowStore.replaceTask(id, next)
}

export function removeTask(id) {
  return workflowStore.removeTask(id)
}

export function moveTask(id, direction) {
  return workflowStore.moveTask(id, direction)
}

export function resetToDefaults() {
  return workflowStore.resetToDefaults()
}

export function replaceAll(next) {
  return workflowStore.replaceAll(next)
}

export function onWorkflowsChange(fn) {
  return workflowStore.onWorkflowsChange(fn)
}

export default WorkflowStore
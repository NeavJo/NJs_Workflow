import { evaluateRotationTag } from '../config/rotation-rules.js'
import { DBG } from '../core/debug.js'
import { I18N } from '../locales.js'
import { getTodayDateString } from '../core/date.js'
import { findRotationRule } from './rotation-store.js'
import { getWorkflows } from './workflow-store.js'
import { hasCompleted, addCompleted, persistCompleted } from './completion-store.js'

/**
 * 工作流运行时：评估任务的动态标签、是否可跟踪、生词本校验。
 * 运行时只读"状态层"store，副作用（如渲染）通过依赖注入由 bootstrap 接入，
 * 避免与 renderer / events 循环依赖。
 */

let memoProvider = () => []
let memoParser = (content) => ({})
let onAfterMemoCheck = null

export function setMemoCountCheckDependencies({ getMemos, parseMemoContentToMap, onAfterComplete } = {}) {
  if (typeof getMemos === 'function') memoProvider = getMemos
  if (typeof parseMemoContentToMap === 'function') memoParser = parseMemoContentToMap
  if (typeof onAfterComplete === 'function') onAfterMemoCheck = onAfterComplete
}

/**
 * 评估任务的运行时状态：
 *  1. 优先用通用 RotationRule 引擎
 *  2. 否则回退到任务内置的 dynamicTag 函数（兼容老数据）
 *  3. 返回 { tagInfo, disabled }
 */
export function evaluateTaskRuntime(task) {
  if (!task) return { tagInfo: null, disabled: false }
  if (task.rotationRuleId) {
    const rule = findRotationRule(task.rotationRuleId)
    if (rule) {
      const info = evaluateRotationTag(rule)
      if (info) return { tagInfo: info, disabled: Boolean(info.disabled) }
    }
  }
  if (typeof task.dynamicTag === 'function') {
    const result = task.dynamicTag() || {}
    return {
      tagInfo: result,
      disabled: Boolean(result.disabled)
    }
  }
  return { tagInfo: null, disabled: false }
}

export function isTaskTrackable(task) {
  if (!task || task.isPlaceholder) return false
  const { disabled } = evaluateTaskRuntime(task)
  if (disabled) return false
  return true
}

export function getTrackableTasks() {
  return getWorkflows().filter(isTaskTrackable)
}

/**
 * 通用生词本校验：按任务的 checkConfig 统计今日指定分类的生词数，
 * 达标（≥ targetCount）自动打卡，否则提示差额。
 */
export function runMemoCountCheck(taskId) {
  const workflows = getWorkflows()
  const task = workflows.find((t) => t.id === taskId)
  if (!task || !task.checkConfig || !task.checkConfig.enabled) {
    DBG('check:memo-count:disabled', { taskId })
    return { ok: false, reason: 'disabled' }
  }

  const cfg = task.checkConfig
  const defaultCategory = I18N.workflow.defaultCategory
  const targetCategory = (cfg.category || defaultCategory).trim().toLowerCase()
  const targetCount = cfg.targetCount || 7

  const todayStr = getTodayDateString()
  const memos = memoProvider() || []
  const todayMemos = memos.filter((m) => String(m.timestamp || '').startsWith(todayStr))

  let wordCount = 0
  todayMemos.forEach((memo) => {
    const categoryMap = memoParser(memo.content)
    Object.keys(categoryMap).forEach((cat) => {
      if (cat.trim().toLowerCase() === targetCategory) {
        wordCount += categoryMap[cat].length
      }
    })
  })

  const displayCategory = cfg.category || I18N.workflow.defaultCategory
  DBG('check:memo-count', { taskId, targetCategory, targetCount, todayMemos: todayMemos.length, wordCount })

  if (wordCount >= targetCount) {
    let changed = false
    if (!hasCompleted(taskId)) {
      changed = addCompleted(taskId)
    }
    if (changed) persistCompleted()
    if (typeof onAfterMemoCheck === 'function') {
      try { onAfterMemoCheck({ taskId, passed: true, wordCount, targetCount, displayCategory }) } catch (e) { DBG('check:onAfter:error', String(e)) }
    }
    return { ok: true, passed: true, wordCount, targetCount, displayCategory, changed }
  }

  const remaining = targetCount - wordCount
  if (typeof onAfterMemoCheck === 'function') {
    try { onAfterMemoCheck({ taskId, passed: false, wordCount, targetCount, displayCategory, remaining }) } catch (e) { DBG('check:onAfter:error', String(e)) }
  }
  return { ok: true, passed: false, wordCount, targetCount, displayCategory, remaining }
}

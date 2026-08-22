import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { getWorkflows } from './workflow-store.js'
import { getCompletedIds, persistCompleted, hasCompleted, toggleCompleted } from './completion-store.js'
import { renderWorkflow } from './workflow-renderer.js'
import { runMemoCountCheck } from './workflow-runtime.js'

/**
 * 工作流事件层：把 DOM 事件桥接到 store 写入 + 渲染。
 * 不持有任何状态，事件回调通过依赖的 store 拿到最新值。
 */

function toggleItem(id, { forced = false } = {}) {
  const task = getWorkflows().find((t) => t.id === id)
  if (!forced && task && task.checkConfig && task.checkConfig.enabled) {
    DBG('toggleItem:blocked-check-lock', { id })
    showToast('此任务由系统自动校验，不可手动打卡，请点击「检查」按钮。')
    renderWorkflow()
    return
  }
  const before = getCompletedIds().has(id)
  DBG('toggleItem:enter', { id, forced, before })
  toggleCompleted(id)
  const persisted = persistCompleted()
  if (!persisted) showToast('任务已更新，但本地存储写入失败。')
  renderWorkflow()
  showToast(hasCompleted(id) ? '任务已完成，继续保持节奏。' : '任务已重新开放。')
}

export function bindWorkflowListEvents() {
  const list = document.querySelector('#workflow-list')
  if (!list) return

  list.addEventListener('change', (event) => {
    const checkbox = event.target.closest('[data-item-id]')
    if (checkbox) toggleItem(checkbox.dataset.itemId)
  })

  list.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-check-action]')
    if (!btn) return
    const action = btn.dataset.checkAction
    const taskId = btn.dataset.itemId
    if (action === 'memo-count') {
      runMemoCountCheck(taskId)
    }
  })
}

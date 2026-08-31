import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N, t } from '../locales.js'
import { getWorkflows } from './workflow-store.js'
import { getCompletedIds, persistCompleted, hasCompleted, toggleCompleted } from './completion-store.js'
import { renderWorkflow } from './workflow-renderer.js'
import { runMemoCountCheck, checkPrerequisites } from './workflow-runtime.js'
import { bindBatch } from '../utils/event-manager.js'

/**
 * 工作流事件层：把 DOM 事件桥接到 store 写入 + 渲染。
 * 不持有任何状态，事件回调通过依赖的 store 拿到最新值。
 */

function toggleItem(id, { forced = false } = {}) {
  const task = getWorkflows().find((t) => t.id === id)
  if (!forced && task && task.checkConfig && task.checkConfig.enabled) {
    DBG('toggleItem:blocked-check-lock', { id })
    showToast(I18N.toast.workflow.systemCheckOnly)
    renderWorkflow()
    return
  }
  // 前置任务检查
  if (!forced && task) {
    const { ready, missingIds } = checkPrerequisites(task)
    if (!ready && missingIds.length > 0) {
    const workflows = getWorkflows()
      const otherTasks = workflows.filter((t) => missingIds.includes(t.id))
      const list = otherTasks.map((t) => `#${String(workflows.indexOf(t) + 1).padStart(2, '0')}`).join(', ')
      showToast(t(I18N.toast.workflow.prerequisitesLocked, { list }))
      renderWorkflow()
      return
    }
  }
  const before = getCompletedIds().has(id)
  DBG('toggleItem:enter', { id, forced, before })
  toggleCompleted(id)
  const persisted = persistCompleted()
  if (!persisted) showToast(I18N.toast.workflow.updateStorageFail)
  renderWorkflow()
  showToast(hasCompleted(id) ? I18N.toast.workflow.completed : I18N.toast.workflow.reopened)
}

export function bindWorkflowListEvents() {
  const list = document.querySelector('#workflow-list')
  if (!list) return

  // 批量绑定工作流列表事件
  const workflowEvents = [
    {
      event: 'change',
      handler: (event) => {
        const checkbox = event.target.closest('[data-item-id]')
        if (checkbox) toggleItem(checkbox.dataset.itemId)
      }
    },
    {
      event: 'click',
      handler: (event) => {
        const btn = event.target.closest('[data-check-action]')
        if (!btn) return
        const action = btn.dataset.checkAction
        const taskId = btn.dataset.itemId
        if (action === 'memo-count') {
          runMemoCountCheck(taskId)
        }
      }
    }
  ]

  // 绑定事件
  bindBatch(list, workflowEvents)

  // 返回清理函数，用于组件销毁时清理事件
  return () => {
    // 清理事件监听器
    list.replaceWith(list.cloneNode(true))
  }
}

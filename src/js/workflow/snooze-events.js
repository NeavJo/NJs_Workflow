import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N, t } from '../locales.js'
import { openModal, closeModal, MODAL_IDS } from '../settings/modal.js'
import { createGuard } from '../utils/guard.js'
import { escapeHtml } from '../utils/dom-utils.js'
import { getCompletedIds } from './completion-store.js'
import { getTrackableTasks } from './workflow-runtime.js'
import { getSnoozeRecord, getSnoozedIds, saveTodaySnoozeSelection } from './snooze-store.js'
import { renderWorkflow } from './workflow-renderer.js'

/**
 * 今日临时搁置事件层：
 *  - 设置页「今日搁置」按钮绑定
 *  - 弹窗复选项动态生成（仅今日可跟踪、未完成、非占位任务）
 *  - 确认保存 / 取消关闭 / 失败保留输入
 *
 * 设计约束：
 *  - 搁置与完成互斥：已完成任务不出现在选择列表中。
 *  - 再次打开弹窗时已搁置任务保持勾选，理由预填；确认时用完整选择集替换当日记录。
 *  - 选择集为空时删除当日搁置记录。
 *  - 持久化失败时保持弹窗打开，不清空用户选择，提示重试。
 */

const snoozeEventsGuard = createGuard('snoozeEventsBound')

function getSnoozeModalRoot() {
  return document.getElementById(MODAL_IDS.snooze)
}

/**
 * 获取今日可搁置任务列表：可跟踪、未完成、非占位。
 * 休息日/已禁用任务由 isTaskTrackable 过滤；已完成任务由 completedIds 过滤。
 */
function getTodaySnoozeCandidates() {
  const completedIds = getCompletedIds()
  return getTrackableTasks().filter(
    (task) => !task.isPlaceholder && !completedIds.has(task.id)
  )
}

/**
 * 渲染弹窗内容：任务复选项 + 理由输入框 + 状态提示。
 * 已搁置任务默认勾选，理由预填当日理由。
 */
function renderSnoozeModal() {
  const root = getSnoozeModalRoot()
  if (!root) return

  const listContainer = root.querySelector('#snooze-task-list')
  const reasonInput = root.querySelector('#snooze-reason-input')
  const statusEl = root.querySelector('#snooze-status')
  if (!listContainer) return

  const candidates = getTodaySnoozeCandidates()
  const snoozedIds = getSnoozedIds()
  const todayRecord = getSnoozeRecord()

  if (candidates.length === 0) {
    listContainer.innerHTML = `<p class="snooze-empty">${I18N.settings.snoozeEmpty}</p>`
  } else {
    listContainer.innerHTML = candidates
      .map((task) => {
        const checked = snoozedIds.has(task.id) ? 'checked' : ''
        return `
          <label class="snooze-task-item">
            <input type="checkbox" class="snooze-task-checkbox" value="${escapeHtml(task.id)}" ${checked} />
            <span class="snooze-task-title"></span>
          </label>`
      })
      .join('')
    // 用 textContent 填充任务标题，防止 HTML 注入
    const titleEls = listContainer.querySelectorAll('.snooze-task-title')
    candidates.forEach((task, i) => {
      if (titleEls[i]) titleEls[i].textContent = task.title
    })
  }

  if (reasonInput) reasonInput.value = todayRecord?.reason || ''
  if (statusEl) {
    statusEl.textContent = ''
    statusEl.classList.remove('is-error')
  }
}

/**
 * 确认保存：收集选中的任务 ID 与理由，调用 Store 保存。
 * 成功后关闭弹窗并刷新；失败时保留弹窗与用户输入，提示错误。
 */
function confirmSnooze() {
  const root = getSnoozeModalRoot()
  if (!root) return

  const checked = root.querySelectorAll('#snooze-task-list .snooze-task-checkbox:checked')
  const taskIds = Array.from(checked).map((cb) => cb.value)
  const reasonInput = root.querySelector('#snooze-reason-input')
  const reason = reasonInput ? reasonInput.value : ''
  const statusEl = root.querySelector('#snooze-status')

  const ok = saveTodaySnoozeSelection(taskIds, reason)
  if (!ok) {
    DBG('snooze:save:failed')
    if (statusEl) {
      statusEl.textContent = I18N.toast.workflow.snoozeSaveFailed
      statusEl.classList.add('is-error')
    }
    showToast(I18N.toast.workflow.snoozeSaveFailed)
    return
  }

  DBG('snooze:save:ok', { count: taskIds.length })
  closeModal('snooze')
  // snooze store 内部已 emit，renderWorkflow 订阅会刷新；此处主动刷新一次保证列表与进度即时更新。
  renderWorkflow()
  if (taskIds.length === 0) {
    showToast(I18N.toast.workflow.snoozeCleared)
  } else {
    showToast(t(I18N.toast.workflow.snoozeSaved, { count: taskIds.length }))
  }
}

/**
 * 绑定弹窗内部按钮（确认 / 取消）。
 * 使用 createGuard 保证幂等，避免重复绑定累积监听。
 */
function bindSnoozeModalEvents() {
  const root = getSnoozeModalRoot()
  if (!root || snoozeEventsGuard.is(root)) return
  snoozeEventsGuard.set(root)

  const confirmBtn = root.querySelector('#snooze-confirm')
  const cancelBtn = root.querySelector('#snooze-cancel')

  if (confirmBtn) {
    confirmBtn.addEventListener('click', () => {
      try {
        confirmSnooze()
      } catch (e) {
        DBG('snooze:confirm:exception', String(e))
        showToast(I18N.toast.workflow.snoozeSaveFailed)
      }
    })
  }
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => closeModal('snooze'))
  }
}

/**
 * 打开搁置弹窗：每次打开重新渲染候选列表（任务状态可能已变化）。
 */
export function openSnoozeModal() {
  try {
    renderSnoozeModal()
    bindSnoozeModalEvents()
    openModal('snooze')
  } catch (e) {
    DBG('snooze:open:exception', String(e))
    showToast(I18N.toast.workflow.snoozeOpenFailed)
  }
}

/**
 * 绑定设置页「今日搁置」入口按钮。
 * 入口位于设置工作流子页；按钮不存在时安全返回。
 */
export function bindSnoozeEvents() {
  const btn = document.getElementById('btn-workflow-snooze')
  if (!btn) {
    DBG('snooze:bind:no-button')
    return
  }
  if (snoozeEventsGuard.is(btn)) return
  snoozeEventsGuard.set(btn)

  btn.addEventListener('click', () => {
    openSnoozeModal()
  })
  DBG('snooze:bound')
}

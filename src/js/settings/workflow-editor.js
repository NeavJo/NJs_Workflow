import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N, t } from '../locales.js'
import { getWorkflows, moveTask, removeTask } from '../workflow/workflow-store.js'
import { renderWorkflow } from '../workflow/workflow-renderer.js'
import { openModal, replaceModal, openConfirmDialog, closeModal } from './modal.js'
import { openTaskForm } from './task-form.js'
import { uploadToGist } from '../backup/gist-sync.js'
import { $, escapeHtml } from '../utils/dom-utils.js'

/**
 * 工作流编辑器：在 settings → workflow 视图中以列表形式展示任务。
 * 桌面：行内显示 上移 / 下移 / 编辑 / 删除 图标按钮。
 * 移动：每行只显示序号 + 标题/描述 + 一个「更多」按钮；
 *      点更多后弹出 Bottom Sheet 菜单，包含 编辑 / 上移 / 下移 / 删除。
 */

function buildMetaLine(task) {
  const parts = []
  if (task.isPlaceholder) parts.push('Coming Soon')
  if (task.url) parts.push('跳转')
  if (task.rotationRuleId) parts.push('轮换')
  if (task.checkConfig?.enabled) {
    const cat = task.checkConfig.category || '常规'
    parts.push(`检查 ${cat}≥${task.checkConfig.targetCount}`)
  }
  if (!parts.length) parts.push('纯打卡')
  return parts.join(' · ')
}

function createEditorTaskRow(task, idx, total) {
  const row = document.createElement('div')
  row.className = 'editor-task-row'
  row.dataset.id = task.id

  const descText = task.desc || (task.url ? task.url : I18N.workflow.noDesc)

  row.innerHTML = `
    <div class="editor-task-row__order">${String(idx + 1).padStart(2, '0')}</div>
    <div class="editor-task-row__body">
      <h4 class="editor-task-row__title"></h4>
      <p class="editor-task-row__desc"></p>
      <p class="editor-task-row__meta"></p>
    </div>
    <button type="button" class="editor-task-row__menu" data-editor-action="menu"
            aria-label="${I18N.workflow.taskOpAria}" aria-haspopup="dialog" aria-controls="editor-action-modal">
      <span class="material-symbols" aria-hidden="true">more_horiz</span>
    </button>
    <div class="editor-task-row__actions">
      <button type="button" class="icon-btn-mini ${idx === 0 ? 'is-disabled' : ''}" data-editor-action="up" title="${I18N.workflow.moveUp}" aria-label="${I18N.workflow.moveUpAria}">
        <span class="material-symbols" aria-hidden="true">arrow_upward</span>
      </button>
      <button type="button" class="icon-btn-mini ${idx === total - 1 ? 'is-disabled' : ''}" data-editor-action="down" title="${I18N.workflow.moveDown}" aria-label="${I18N.workflow.moveDownAria}">
        <span class="material-symbols" aria-hidden="true">arrow_downward</span>
      </button>
      <button type="button" class="icon-btn-mini" data-editor-action="edit" title="${I18N.workflow.editAria}" aria-label="${I18N.workflow.editAria}">
        <span class="material-symbols" aria-hidden="true">edit</span>
      </button>
      <button type="button" class="icon-btn-mini icon-btn-mini--danger" data-editor-action="delete" title="${I18N.workflow.deleteAria}" aria-label="${I18N.workflow.deleteAria}">
        <span class="material-symbols" aria-hidden="true">delete</span>
      </button>
    </div>`

  row.querySelector('.editor-task-row__title').textContent = task.title || I18N.workflow.untitledTask
  row.querySelector('.editor-task-row__desc').textContent = descText
  row.querySelector('.editor-task-row__meta').textContent = buildMetaLine(task)
  return row
}

function openTaskActionSheet(taskId) {
  const workflows = getWorkflows()
  const idx = workflows.findIndex((t) => t.id === taskId)
  if (idx === -1) return
  const task = workflows[idx]

  const root = document.getElementById('editor-action-modal')
  if (!root) return
  root.dataset.taskId = taskId

  const subtitle = root.querySelector('#editor-action-subtitle')
  if (subtitle) subtitle.textContent = task.title || I18N.workflow.untitledTask

  const list = root.querySelector('#editor-action-list')
  if (!list) return

  const isFirst = idx === 0
  const isLast = idx === workflows.length - 1

  const items = [
    { key: 'edit', icon: 'edit', label: I18N.workflow.editTask, disabled: false },
    { key: 'up', icon: 'arrow_upward', label: I18N.workflow.moveUp, disabled: isFirst },
    { key: 'down', icon: 'arrow_downward', label: I18N.workflow.moveDown, disabled: isLast },
    { key: 'delete', icon: 'delete', label: I18N.workflow.deleteTask, danger: true, disabled: false }
  ]

  list.replaceChildren(
    ...items.map((it) => {
      const li = document.createElement('li')
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.dataset.sheetAction = it.key
      btn.disabled = Boolean(it.disabled)
      if (it.danger) btn.classList.add('is-danger')
      btn.innerHTML = `<span class="material-symbols" aria-hidden="true">${it.icon}</span><span>${escapeHtml(it.label)}</span>`
      li.appendChild(btn)
      return li
    })
  )

  openModal('editor-action')
}

async function performDelete(taskId) {
  try {
    const workflows = getWorkflows()
    const task = workflows.find((w) => w.id === taskId)
    if (!task) return
    const title = task.title || I18N.workflow.untitledTask
    const ok = await openConfirmDialog({
      title: I18N.workflow.deleteConfirmTitle,
      message: t(I18N.workflow.deleteConfirmMsg, { title }),
      confirmText: I18N.common.delete,
      cancelText: I18N.common.cancel,
      danger: true
    })
    if (!ok) return
    removeTask(taskId)
    renderEditorList()
    renderWorkflow()
    showToast(I18N.toast.workflow.taskDeleted)
    DBG('editor:delete', taskId)

    // 添加Gist上传触发：失败不影响本地删除结果，吞掉 rejection
    await uploadToGist().catch((err) => DBG('editor:delete:gist', String(err)))
  } catch (e) {
    DBG('editor:delete:error', String(e))
    showToast('删除任务失败')
  }
}

function handleEditorAction(event) {
  const btn = event.target.closest('button[data-editor-action]')
  if (!btn) return
  const row = btn.closest('.editor-task-row')
  if (!row) return
  const id = row.dataset.id
  const action = btn.dataset.editorAction

  if (action === 'menu') {
    openTaskActionSheet(id)
    DBG('editor:sheet', id)
    return
  }
  if (action === 'edit') {
    replaceModal('editor', 'taskform', { opener: btn }).then(() => openTaskForm('edit', id, true)).catch((e) => DBG('editor:edit:action', String(e)))
    return
  }

  const workflows = getWorkflows()
  const i = workflows.findIndex((t) => t.id === id)
  if (i === -1) return

  if (action === 'up') {
    if (i === 0) return
    moveTask(id, 'up')
    renderEditorList()
    renderWorkflow()
  } else if (action === 'down') {
    if (i === workflows.length - 1) return
    moveTask(id, 'down')
    renderEditorList()
    renderWorkflow()
  } else if (action === 'delete') {
    performDelete(id)
  }
  DBG('editor:action', { action, id })
}

async function handleSheetAction(event) {
  try {
    const btn = event.target.closest('button[data-sheet-action]')
    if (!btn) return
    const action = btn.dataset.sheetAction
    const root = document.getElementById('editor-action-modal')
    const taskId = root?.dataset?.taskId
    if (!taskId) return

    closeModal('editor-action')

    if (action === 'edit') {
      await replaceModal('editor', 'taskform', { opener: btn }).catch((e) => DBG('editor:edit:sheet', String(e)))
      openTaskForm('edit', taskId, true)
      return
    }

    const workflows = getWorkflows()
    const i = workflows.findIndex((t) => t.id === taskId)
    if (i === -1) return

    if (action === 'up' || action === 'down') {
      const target = action === 'up' ? i - 1 : i + 1
      if (target < 0 || target >= workflows.length) return
      moveTask(taskId, action)
      renderEditorList()
      renderWorkflow()
    } else if (action === 'delete') {
      await performDelete(taskId)
    }
    DBG('editor:sheet:action', { action, id: taskId })
  } catch (e) {
    DBG('editor:sheet:error', String(e))
    showToast('操作任务失败')
  }
}

export function renderEditorList() {
  const list = document.getElementById('editor-task-list')
  const empty = document.getElementById('editor-empty')
  const countLabel = document.getElementById('editor-task-count')
  if (!list) return
  const workflows = getWorkflows()
  if (countLabel) countLabel.textContent = t(I18N.workflow.taskCount, { count: workflows.length })

  if (!workflows.length) {
    list.innerHTML = ''
    if (empty) empty.hidden = false
    return
  }
  if (empty) empty.hidden = true

  list.replaceChildren(...workflows.map((task, idx) => createEditorTaskRow(task, idx, workflows.length)))
}

export function openEditorDialog() {
  renderEditorList()
  openModal('editor')
}

export function bindEditorListEvents() {
  const list = document.getElementById('editor-task-list')
  if (list && !list.dataset.bound) {
    list.dataset.bound = '1'
    list.addEventListener('click', handleEditorAction)
  }

  const sheetList = document.getElementById('editor-action-list')
  if (sheetList && !sheetList.dataset.bound) {
    sheetList.dataset.bound = '1'
    sheetList.addEventListener('click', handleSheetAction)
  }
}
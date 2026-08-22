import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { getWorkflows, moveTask, removeTask } from '../workflow/workflow-store.js'
import { renderWorkflow } from '../workflow/workflow-renderer.js'
import { openModal, replaceModal, openConfirmDialog, closeModal } from './modal.js'
import { openTaskForm } from './task-form.js'

/**
 * 工作流编辑器：在 settings → workflow 视图中以列表形式展示任务。
 * 桌面：行内显示 上移 / 下移 / 编辑 / 删除 图标按钮。
 * 移动：每行只显示序号 + 标题/描述 + 一个「更多」按钮；
 *      点更多后弹出 Bottom Sheet 菜单，包含 编辑 / 上移 / 下移 / 删除。
 */

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]))
}

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

  const descText = task.desc || (task.url ? task.url : '（无描述）')

  row.innerHTML = `
    <div class="editor-task-row__order">${String(idx + 1).padStart(2, '0')}</div>
    <div class="editor-task-row__body">
      <h4 class="editor-task-row__title"></h4>
      <p class="editor-task-row__desc"></p>
      <p class="editor-task-row__meta"></p>
    </div>
    <button type="button" class="editor-task-row__menu" data-editor-action="menu"
            aria-label="任务操作" aria-haspopup="dialog" aria-controls="editor-action-modal">
      <span class="material-symbols" aria-hidden="true">more_horiz</span>
    </button>
    <div class="editor-task-row__actions">
      <button type="button" class="icon-btn-mini ${idx === 0 ? 'is-disabled' : ''}" data-editor-action="up" title="上移" aria-label="上移">
        <span class="material-symbols" aria-hidden="true">arrow_upward</span>
      </button>
      <button type="button" class="icon-btn-mini ${idx === total - 1 ? 'is-disabled' : ''}" data-editor-action="down" title="下移" aria-label="下移">
        <span class="material-symbols" aria-hidden="true">arrow_downward</span>
      </button>
      <button type="button" class="icon-btn-mini" data-editor-action="edit" title="编辑" aria-label="编辑">
        <span class="material-symbols" aria-hidden="true">edit</span>
      </button>
      <button type="button" class="icon-btn-mini icon-btn-mini--danger" data-editor-action="delete" title="删除" aria-label="删除">
        <span class="material-symbols" aria-hidden="true">delete</span>
      </button>
    </div>`

  row.querySelector('.editor-task-row__title').textContent = task.title || '未命名任务'
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
  if (subtitle) subtitle.textContent = task.title || '未命名任务'

  const list = root.querySelector('#editor-action-list')
  if (!list) return

  const isFirst = idx === 0
  const isLast = idx === workflows.length - 1

  const items = [
    { key: 'edit', icon: 'edit', label: '编辑任务', disabled: false },
    { key: 'up', icon: 'arrow_upward', label: '上移', disabled: isFirst },
    { key: 'down', icon: 'arrow_downward', label: '下移', disabled: isLast },
    { key: 'delete', icon: 'delete', label: '删除任务', danger: true, disabled: false }
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
  const workflows = getWorkflows()
  const t = workflows.find((w) => w.id === taskId)
  if (!t) return
  const title = t.title || '未命名任务'
  const ok = await openConfirmDialog({
    title: '删除任务？',
    message: `「${title}」将从工作流中移除，此操作无法撤销。`,
    confirmText: '删除',
    cancelText: '取消',
    danger: true
  })
  if (!ok) return
  removeTask(taskId)
  renderEditorList()
  renderWorkflow()
  showToast('任务已删除。')
  DBG('editor:delete', taskId)
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
    replaceModal('editor', 'taskform', { opener: btn }).then(() => openTaskForm('edit', id))
    return
  }

  const workflows = getWorkflows()
  const i = workflows.findIndex((t) => t.id === id)
  if (i === -1) return

  if (action === 'up') {
    if (i === 0) return
    moveTask(i, i - 1)
    renderEditorList()
  } else if (action === 'down') {
    if (i === workflows.length - 1) return
    moveTask(i, i + 1)
    renderEditorList()
  } else if (action === 'delete') {
    performDelete(id)
  }
  DBG('editor:action', { action, id })
}

async function handleSheetAction(event) {
  const btn = event.target.closest('button[data-sheet-action]')
  if (!btn) return
  const action = btn.dataset.sheetAction
  const root = document.getElementById('editor-action-modal')
  const taskId = root?.dataset?.taskId
  if (!taskId) return

  closeModal('editor-action')

  if (action === 'edit') {
    await replaceModal('editor', 'taskform', { opener: btn })
    openTaskForm('edit', taskId)
    return
  }

  const workflows = getWorkflows()
  const i = workflows.findIndex((t) => t.id === taskId)
  if (i === -1) return

  if (action === 'up' || action === 'down') {
    const target = action === 'up' ? i - 1 : i + 1
    if (target < 0 || target >= workflows.length) return
    moveTask(i, target)
    renderEditorList()
  } else if (action === 'delete') {
    await performDelete(taskId)
  }
  DBG('editor:sheet:action', { action, id: taskId })
}

export function renderEditorList() {
  const list = document.getElementById('editor-task-list')
  const empty = document.getElementById('editor-empty')
  const countLabel = document.getElementById('editor-task-count')
  if (!list) return
  const workflows = getWorkflows()
  if (countLabel) countLabel.textContent = `共 ${workflows.length} 条任务`

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
import { DBG } from '../core/debug.js'
import { closeModal, replaceModal, isModalOpen } from './modal.js'
import { switchSettingsView, registerViewHook } from './navigation.js'
import {
  renderSettingsTagList,
  addMemoTagFromInput,
  startEditMemoTag,
  deleteMemoTagFromSettings
} from './tag-settings.js'
import { openEditorDialog, renderEditorList, bindEditorListEvents } from './workflow-editor.js'
import { openTaskForm, closeTaskForm, bindTaskFormEvents } from './task-form.js'
export { bindTaskFormEvents }
import { renderGistSettingsInputs } from '../backup/gist-sync.js'
import { renderDailyResetStatus } from '../backup/daily-reset.js'
/**
 * 设置域事件绑定集合 + 顶级页面进入钩子。
 *  - bindNavigationEvents()：顶部主导航（flow / memo / settings）
 *  - bindSettingsEvents()：顶级设置页事件（子页面、返回、工作流快捷按钮、标签 CRUD）
 *  - bindEditorEvents()：任务编辑器模态
 *  - bindTaskFormEvents()：任务表单模态（含 rotation 编辑器）
 *  - bindGlobalEscapeHandler()：Esc 关闭优先级（taskform > rotation > editor > settings 子页面）
 *
 * 备份相关按钮（导出 / 重置 / Gist / Drop Zone）由 backup/events.js 提供，
 * 通过 registerBackupEvents(fn) 注入。
 */

let backupBindings = null
let settingsEntered = false

export function registerBackupEvents(fn) {
  backupBindings = typeof fn === 'function' ? fn : null
}

function getSettingsRoot() {
  return document.querySelector('.view--settings[data-view="settings"]')
}

/* ====================================================================
 * 顶级设置页：进入钩子
 *   由 navigation.switchView('settings') 通过 registerViewHook 触发。
 *   在首次进入或重新进入设置页时刷新动态内容。
 * ==================================================================== */

export function enterSettingsView(options = {}) {
  const resetSubpage = options.resetSubpage !== false
  if (resetSubpage || !settingsEntered) {
    switchSettingsView('main', { skipIntro: true })
  }
  settingsEntered = true

  renderSettingsTagList()
  renderGistSettingsInputs()
  renderDailyResetStatus()
  renderEditorList()
}

registerViewHook('settings', () => enterSettingsView({ resetSubpage: true }))

/* ====================================================================
 * 子页面导航、标签管理、备份相关按钮
 * ==================================================================== */

function handleSettingsSubNavigation(event) {
  const navItem = event.target.closest('[data-settings-page]')
  if (navItem) {
    switchSettingsView(navItem.dataset.settingsPage)
    return
  }
  const backItem = event.target.closest('[data-settings-back]')
  if (backItem) {
    switchSettingsView('main')
  }
}

function handleSettingsTagActions(event) {
  const renameBtn = event.target.closest('[data-action="rename-memo-tag"]')
  if (renameBtn) {
    startEditMemoTag(renameBtn.dataset.id)
    return
  }
  const deleteBtn = event.target.closest('[data-action="delete-memo-tag"]')
  if (deleteBtn) {
    deleteMemoTagFromSettings(deleteBtn.dataset.id)
  }
}

function handleSettingsWorkflowButtons(event) {
  const addBtn = event.target.closest('#btn-workflow-add')
  if (addBtn) {
    openTaskForm('add')
    return
  }
  const editBtn = event.target.closest('#btn-workflow-edit')
  if (editBtn) {
    openEditorDialog()
  }
}

function bindSettingsTagCrud(root) {
  const scope = root || getSettingsRoot()
  if (!scope) return
  const tagAddBtn = scope.querySelector('#btn-tag-add')
  const tagInput = scope.querySelector('#settings-tag-input')
  if (tagAddBtn) tagAddBtn.addEventListener('click', addMemoTagFromInput)
  if (tagInput) {
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        addMemoTagFromInput()
      }
    })
  }
  const list = scope.querySelector('#settings-tag-list')
  if (list) list.addEventListener('click', handleSettingsTagActions)
}

export function bindSettingsEvents() {
  const root = getSettingsRoot()
  if (!root) {
    DBG('settings:bind:no-root')
    return
  }

  if (root.dataset.bound !== '1') {
    root.dataset.bound = '1'
    root.addEventListener('click', handleSettingsSubNavigation)
    root.addEventListener('click', handleSettingsWorkflowButtons)
  }

  bindSettingsTagCrud(root)

  root.querySelectorAll('[data-settings-page]').forEach((item) => {
    // 幂等守卫：只有此处统一刷新 Gist + daily-reset 状态。
    // backup/events.js 与 daily-reset.js 的两处重复监听仅处理自身状态，见各自 dataset.bound。
    if (item.dataset.bound === '1') return
    item.dataset.bound = '1'
    item.addEventListener('click', () => {
      if (item.dataset.settingsPage === 'backup') {
        renderGistSettingsInputs()
        renderDailyResetStatus()
      }
    })
  })

  if (backupBindings) {
    try {
      backupBindings()
    } catch (e) {
      DBG('settings:backup-bindings', String(e))
    }
  }

  DBG('settings:bound')
}

/* ====================================================================
 * 任务编辑器模态
 * ==================================================================== */

export function bindEditorEvents() {
  const closeBtn = document.getElementById('editor-close')
  const scrim = document.querySelector('#editor-modal .modal__scrim')
  const addBtn = document.getElementById('editor-btn-add')
  const emptyAddBtn = document.getElementById('editor-empty-add')
  const taskFormBack = document.getElementById('taskform-back')

  const closeEditor = () => closeModal('editor')
  if (closeBtn && !closeBtn.dataset.bound) {
    closeBtn.dataset.bound = '1'
    closeBtn.addEventListener('click', closeEditor)
  }
  if (scrim && !scrim.dataset.bound) {
    scrim.dataset.bound = '1'
    scrim.addEventListener('click', closeEditor)
  }

  const openAddForm = (opener) => replaceModal('editor', 'taskform', { opener }).then(() => openTaskForm('add', null, true)).catch((e) => DBG('settings:open-add-form', String(e)))

  if (addBtn) addBtn.addEventListener('click', () => openAddForm(addBtn))
  if (emptyAddBtn) emptyAddBtn.addEventListener('click', () => openAddForm(emptyAddBtn))

  if (taskFormBack && !taskFormBack.dataset.bound) {
    taskFormBack.dataset.bound = '1'
    taskFormBack.addEventListener('click', () => replaceModal('taskform', 'editor'))
  }

  bindEditorListEvents()
}

/* ====================================================================
 * 全局 Esc 关闭：rotation > taskform > editor > settings 子页面返回 main
 *   实际绑定在 task-form.js 的 bindTaskFormEvents 中（包含 close/scrim 等）
 * ==================================================================== */

export function bindGlobalEscapeHandler() {
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    // confirm 弹窗叠在最上层（含 settings 子页面 / 抽屉场景），Esc 优先取消它，
    // 避免穿透到下面的 switchSettingsView('main') 把确认静默关掉。
    if (isModalOpen('confirm')) {
      closeModal('confirm')
      return
    }
    const rot = document.getElementById('taskform-rotation-modal')
    if (rot && !rot.hidden) {
      replaceModal('rotation', 'taskform')
      return
    }
    const tf = document.getElementById('taskform-modal')
    if (tf && !tf.hidden) {
      closeTaskForm()
      return
    }
    const ed = document.getElementById('editor-modal')
    if (ed && !ed.hidden) {
      closeModal('editor')
      return
    }
    if (typeof switchSettingsView === 'function') {
      switchSettingsView('main', { skipIntro: true })
    }
  })
}
import { DBG } from '../core/debug.js'
import { closeModal, replaceModal, isModalOpen, openModal, registerModalCloseCleanup } from './modal.js'
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
import { renderGermanFontSizeSettings, renderTtsKeyInput } from '../german/german-settings.js'
import { renderAnkiExportSettings } from '../anki/index.js'
import { getUserSettings, setUserSettings, persistUserSettings } from '../core/settings-store.js'
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
let generalSettingsBound = false

export function registerBackupEvents(fn) {
  backupBindings = typeof fn === 'function' ? fn : null
}

/* ====================================================================
 * 通用设置：高级视觉开关
 *   - renderGeneralSettings()：根据存储值回显开关
 *   - bindGeneralSettingsEvents()：绑定一次 change 事件，写入存储并切换 body 类
 *   - 开启属于受控动作：先弹密码框，校验通过后才允许真正打开
 * ==================================================================== */
const ADVANCED_VISUAL_PASSWORD = '0404'

export function applyAdvancedVisualBodyClass(enabled) {
  document.body.classList.toggle('is-advanced-visual', Boolean(enabled))
  if (enabled) return
  // 关闭时必须清理悬停激活态与残留粒子，避免关闭后仍保留 DOM 与后续动画状态。
  document.querySelectorAll('.workflow-card.is-pointer-active').forEach((card) => {
    card.classList.remove('is-pointer-active')
    const layer = card.querySelector('.workflow-card__particles')
    if (!layer) return
    const simulation = layer.workflowFairySimulation
    if (simulation) {
      // 先停掉待执行的跟随帧，避免关闭后仍有一帧渲染开销。
      simulation.active = false
      cancelAnimationFrame(simulation.raf)
    }
    layer.style.transform = ''
    layer.replaceChildren()
    delete layer.workflowFairySimulation
  })
}

function setAdvancedVisualEnabled(enabled) {
  const next = { ...getUserSettings(), advancedVisual: enabled }
  setUserSettings(next)
  persistUserSettings()
  applyAdvancedVisualBodyClass(enabled)
  const toggle = document.getElementById('advanced-visual')
  if (toggle) toggle.checked = enabled
  DBG('settings:general:advancedVisual', { enabled })
}

function resetAdvancedVisualLock() {
  const lockInput = document.getElementById('advanced-visual-lock-input')
  const error = document.getElementById('advanced-visual-lock-error')
  if (lockInput) lockInput.value = ''
  if (error) error.hidden = true
}

function openAdvancedVisualLock() {
  const lockInput = document.getElementById('advanced-visual-lock-input')
  const error = document.getElementById('advanced-visual-lock-error')
  if (lockInput) lockInput.value = ''
  if (error) error.hidden = true
  // 每次打开都注册一次关闭清理，保证遮罩/Esc/取消关闭后输入与错误提示被重置。
  registerModalCloseCleanup('advancedVisualLock', resetAdvancedVisualLock)
  openModal('advancedVisualLock')
  // openModal 会把焦点放到第一个可聚焦元素（关闭按钮），这里延后拉回密码输入框。
  setTimeout(() => {
    const input = document.getElementById('advanced-visual-lock-input')
    if (input) input.focus({ preventScroll: true })
  }, 220)
}

export function renderGeneralSettings() {
  const input = document.getElementById('advanced-visual')
  const openParams = document.getElementById('visual-params-open')
  if (input) input.checked = Boolean(getUserSettings().advancedVisual)
  if (openParams) openParams.setAttribute('aria-expanded', 'false')
}

function bindGeneralSettingsEvents() {
  if (generalSettingsBound) return
  const input = document.getElementById('advanced-visual')
  const speedInput = document.getElementById('workflow-border-particle-speed')
  const driftSpeedInput = document.getElementById('workflow-fairy-drift-speed')
  const chaseSpeedInput = document.getElementById('workflow-fairy-chase-speed')
  const openParams = document.getElementById('visual-params-open')
  const lockConfirm = document.getElementById('advanced-visual-lock-confirm')
  const lockInput = document.getElementById('advanced-visual-lock-input')
  if (!input && !speedInput && !driftSpeedInput && !chaseSpeedInput && !openParams) return
  generalSettingsBound = true
  if (input) input.addEventListener('change', () => {
    if (input.checked) {
      // 先退回关闭，校验通过后由 setAdvancedVisualEnabled 真正打开，
      // 避免密码框展示期间开关已经呈现开启而特效尚未启用。
      input.checked = false
      openAdvancedVisualLock()
      return
    }
    setAdvancedVisualEnabled(false)
  })
  if (lockConfirm && lockInput) {
    const lockError = document.getElementById('advanced-visual-lock-error')
    const submitLock = () => {
      if (lockInput.value.trim() !== ADVANCED_VISUAL_PASSWORD) {
        if (lockError) lockError.hidden = false
        lockInput.focus({ preventScroll: true })
        DBG('settings:general:advancedVisualLock', { result: 'denied' })
        return
      }
      setAdvancedVisualEnabled(true)
      resetAdvancedVisualLock()
      closeModal('advancedVisualLock')
      DBG('settings:general:advancedVisualLock', { result: 'granted' })
    }
    lockConfirm.addEventListener('click', submitLock)
    lockInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        submitLock()
      }
    })
    // 用户重新输入时先收起错误提示，避免错误状态一直停留。
    lockInput.addEventListener('input', () => {
      if (lockError) lockError.hidden = true
    })
  }
  if (speedInput) {
    const saveSpeed = () => {
      if (speedInput.value === '') return
      const speed = Math.min(10, Math.max(0.01, Number(speedInput.value)))
      if (!Number.isFinite(speed)) {
        speedInput.value = Number(getUserSettings().workflowBorderParticleSpeed ?? 1).toFixed(2)
        return
      }
      speedInput.value = speed.toFixed(2)
      const next = { ...getUserSettings(), workflowBorderParticleSpeed: speed }
      setUserSettings(next)
      persistUserSettings()
      DBG('settings:general:workflowBorderParticleSpeed', { speed })
    }
    speedInput.addEventListener('change', saveSpeed)
    speedInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        saveSpeed()
        speedInput.blur()
      }
    })
    speedInput.addEventListener('blur', () => {
      if (speedInput.value === '') {
        speedInput.value = Number(getUserSettings().workflowBorderParticleSpeed ?? 1).toFixed(2)
      } else {
        saveSpeed()
      }
    })
  }
  if (driftSpeedInput) {
    const saveDriftSpeed = () => {
      if (driftSpeedInput.value === '') return
      const speed = Number(driftSpeedInput.value)
      if (!Number.isFinite(speed)) {
        driftSpeedInput.value = Number(getUserSettings().workflowFairyDriftSpeed ?? 1).toFixed(2)
        return
      }
      const normalizedSpeed = Math.min(10, Math.max(0.01, speed))
      driftSpeedInput.value = normalizedSpeed.toFixed(2)
      const next = { ...getUserSettings(), workflowFairyDriftSpeed: normalizedSpeed }
      setUserSettings(next)
      persistUserSettings()
      DBG('settings:general:workflowFairyDriftSpeed', { speed: normalizedSpeed })
    }
    driftSpeedInput.addEventListener('change', saveDriftSpeed)
    driftSpeedInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        saveDriftSpeed()
        driftSpeedInput.blur()
      }
    })
    driftSpeedInput.addEventListener('blur', () => {
      if (driftSpeedInput.value === '') {
        driftSpeedInput.value = Number(getUserSettings().workflowFairyDriftSpeed ?? 1).toFixed(2)
      } else {
        saveDriftSpeed()
      }
    })
  }
  if (chaseSpeedInput) {
    const saveChaseSpeed = () => {
      if (chaseSpeedInput.value === '') return
      const speed = Number(chaseSpeedInput.value)
      if (!Number.isFinite(speed)) {
        chaseSpeedInput.value = Number(getUserSettings().workflowFairyChaseSpeed ?? 1).toFixed(2)
        return
      }
      const normalizedSpeed = Math.min(10, Math.max(0.01, speed))
      chaseSpeedInput.value = normalizedSpeed.toFixed(2)
      const next = { ...getUserSettings(), workflowFairyChaseSpeed: normalizedSpeed }
      setUserSettings(next)
      persistUserSettings()
      DBG('settings:general:workflowFairyChaseSpeed', { speed: normalizedSpeed })
    }
    chaseSpeedInput.addEventListener('change', saveChaseSpeed)
    chaseSpeedInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        saveChaseSpeed()
        chaseSpeedInput.blur()
      }
    })
    chaseSpeedInput.addEventListener('blur', () => {
      if (chaseSpeedInput.value === '') {
        chaseSpeedInput.value = Number(getUserSettings().workflowFairyChaseSpeed ?? 1).toFixed(2)
      } else {
        saveChaseSpeed()
      }
    })
  }
  if (openParams) {
    openParams.addEventListener('click', () => {
      const speed = document.getElementById('workflow-border-particle-speed')
      const driftSpeed = document.getElementById('workflow-fairy-drift-speed')
      const chaseSpeed = document.getElementById('workflow-fairy-chase-speed')
      if (speed) speed.value = Number(getUserSettings().workflowBorderParticleSpeed ?? 1).toFixed(2)
      if (driftSpeed) driftSpeed.value = Number(getUserSettings().workflowFairyDriftSpeed ?? 1).toFixed(2)
      if (chaseSpeed) chaseSpeed.value = Number(getUserSettings().workflowFairyChaseSpeed ?? 1).toFixed(2)
      openParams.setAttribute('aria-expanded', 'true')
      registerModalCloseCleanup('visualParams', () => openParams.setAttribute('aria-expanded', 'false'))
      openModal('visualParams')
    })
  }
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
    // 幂等守卫：只有此处统一刷新各子页动态内容。
    // backup/events.js 与 daily-reset.js 的两处重复监听仅处理自身状态，见各自 dataset.bound。
    if (item.dataset.bound === '1') return
    item.dataset.bound = '1'
    item.addEventListener('click', () => {
      if (item.dataset.settingsPage === 'backup') {
        renderGistSettingsInputs()
        renderDailyResetStatus()
      } else if (item.dataset.settingsPage === 'german') {
        renderGermanFontSizeSettings()
        renderTtsKeyInput()
      } else if (item.dataset.settingsPage === 'anki-export') {
        renderAnkiExportSettings()
      } else if (item.dataset.settingsPage === 'general') {
        renderGeneralSettings()
        bindGeneralSettingsEvents()
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
    // 密码弹窗独立处理，避免 Esc 穿透到设置子页面切换。
    if (isModalOpen('advancedVisualLock')) {
      closeModal('advancedVisualLock')
      return
    }
    const snooze = document.getElementById('snooze-modal')
    if (snooze && !snooze.hidden) {
      closeModal('snooze')
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
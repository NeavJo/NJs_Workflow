import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { createTask, normalizeCheckConfig } from '../config/workflow-config.js'
import {
  getRotationRules,
  findRotationRule
} from '../workflow/rotation-store.js'
import {
  getWorkflows,
  replaceTask as replaceTaskStore,
  addTask as addTaskStore
} from '../workflow/workflow-store.js'
import { renderWorkflow } from '../workflow/workflow-renderer.js'
import { renderEditorList } from './workflow-editor.js'
import {
  openModal,
  closeModal,
  replaceModal
} from './modal.js'
import { bindRotationModalEvents, openRotationModal } from './rotation-editor.js'

/**
 * TaskForm —— 新增 / 编辑任务表单（移动端友好）
 *
 * HTML 结构（见 index.html#taskform-modal）：
 *   basic     ：title / desc
 *   behavior  ：url / placeholder switch
 *   rotation  ：
 *     - 「启用轮换」开关（#taskform-rotation-enabled）
 *     - 链接行（#taskform-rotation-open）：开启后才可点击，进入 rotation modal
 *     - 隐藏字段（#taskform-rotation-id）记录选中的预设 ID
 *   check     ：开关 + 渐进披露的分类 / 数量输入区
 *
 * 「启用轮换」+「选中预设」共同决定任务是否带轮换：
 *   - 开关关 → rotationRuleId = null
 *   - 开关开 + 已选预设 → rotationRuleId = 预设 id
 *   - 开关开 + 未选预设 → 链接行仍可点击，让用户去挑预设
 */

let currentMode = 'add'
let currentEditingId = null

function $(id) {
  return document.getElementById(id)
}

function setFieldError(fieldId, message) {
  const input = $(fieldId)
  if (!input) return
  const helper = input.closest('.form-field')?.querySelector('.form-field__helper')
  if (!helper) return
  if (message) {
    input.classList.add('is-invalid')
    helper.textContent = message
    helper.classList.add('is-error')
  } else {
    input.classList.remove('is-invalid')
    helper.classList.remove('is-error')
  }
}

function clearTaskFormErrors() {
  setFieldError('taskform-title-input', '')
  setFieldError('taskform-desc', '')
  setFieldError('taskform-url', '')
  const titleHelper = $('taskform-title-helper')
  if (titleHelper) {
    titleHelper.textContent = '必填，最多 64 字。'
    titleHelper.classList.remove('is-error')
  }
}

/* ============================================================
 * 启用轮换开关：门控链接行 + 隐藏 ID 字段
 * ============================================================ */
function applyRotationEnabledUI() {
  const enabledInput = $('taskform-rotation-enabled')
  const link = $('taskform-rotation-open')
  const idInput = $('taskform-rotation-id')
  if (!enabledInput || !link) return
  const enabled = Boolean(enabledInput.checked)
  if (enabled) {
    link.removeAttribute('disabled')
    link.removeAttribute('aria-disabled')
    link.classList.remove('is-disabled')
  } else {
    link.setAttribute('disabled', '')
    link.setAttribute('aria-disabled', 'true')
    link.classList.add('is-disabled')
  }
  if (idInput && !enabled) {
    /* 关闭时不立即清空 idInput，保留以便用户重新开启时恢复 */
  }
}

function bindRotationEnabledSwitch() {
  const sw = $('taskform-rotation-enabled')
  if (!sw || sw.dataset.bound === '1') return
  sw.dataset.bound = '1'
  sw.addEventListener('change', () => {
    applyRotationEnabledUI()
    renderRotationSummary($('taskform-rotation-id')?.value || '')
  })
}

/* ============================================================
 * 旋转规则摘要：根据当前 ID 渲染 taskform-link-row 的标题/副标题
 * ============================================================ */
export function renderRotationSummary(rotationRuleId) {
  const titleEl = $('taskform-rotation-summary-title')
  const descEl = $('taskform-rotation-summary-desc')
  const idInput = $('taskform-rotation-id')
  const enabledInput = $('taskform-rotation-enabled')
  if (!titleEl || !descEl || !idInput) return

  idInput.value = rotationRuleId || ''
  const enabled = enabledInput ? Boolean(enabledInput.checked) : true

  if (!enabled) {
    titleEl.textContent = '未启用轮换'
    descEl.textContent = '开启上方开关后，从预设中选择一项。'
    return
  }
  if (!rotationRuleId) {
    titleEl.textContent = '未选择预设'
    descEl.textContent = '点按下方按钮，从预设中选择一项。'
    return
  }
  const rule = findRotationRule(rotationRuleId)
  if (!rule) {
    titleEl.textContent = '所选预设已被删除'
    descEl.textContent = '点按下方按钮，重新选择。'
    return
  }
  titleEl.textContent = rule.name || '未命名轮换规则'
  const today = WEEKDAY_LABELS_FULL[new Date().getDay()]
  descEl.textContent = `共 7 天配置 · 点按可编辑标题、图标与休息日。`
}

const WEEKDAY_LABELS_FULL = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/* ============================================================
 * 自动检查区：渐进披露开关 + 内嵌配置项
 * ============================================================ */
function applyCheckFieldVisibility() {
  const sw = $('taskform-check')
  const fields = $('taskform-check-fields')
  if (!sw || !fields) return
  fields.hidden = !sw.checked
}

function bindCheckSwitch() {
  const sw = $('taskform-check')
  if (!sw || sw.dataset.bound === '1') return
  sw.dataset.bound = '1'
  sw.addEventListener('change', applyCheckFieldVisibility)
}

/* ============================================================
 * 轮换规则入口：点击 link-row → 打开 rotation modal
 * ============================================================ */
function bindRotationLink() {
  const link = $('taskform-rotation-open')
  if (!link || link.dataset.bound === '1') return
  link.dataset.bound = '1'
  link.addEventListener('click', async () => {
    if (link.hasAttribute('disabled')) return
    const idInput = $('taskform-rotation-id')
    const id = idInput?.value || ''
    await replaceModal('taskform', 'rotation', { opener: link })
    openRotationModal(id || null)
  })
}
/* ============================================================
 * 打开表单：填充初始值
 * ============================================================ */
export function openTaskForm(mode = 'add', taskId = null) {
  currentMode = mode
  currentEditingId = taskId
  clearTaskFormErrors()

  const titleEl = $('taskform-title')
  const subtitleEl = $('taskform-subtitle')

  const fTitle = $('taskform-title-input')
  const fDesc = $('taskform-desc')
  const fUrl = $('taskform-url')
  const fPlaceholder = $('taskform-placeholder')
  const fCheck = $('taskform-check')
  const fCheckCategory = $('taskform-check-category')
  const fCheckCount = $('taskform-check-count')
  const fRotEnabled = $('taskform-rotation-enabled')

  let rotationRuleId = null

  if (mode === 'edit' && taskId) {
    const task = getWorkflows().find((t) => t.id === taskId)
    if (!task) {
      showToast('找不到该任务，可能已被删除。')
      return
    }
    if (titleEl) titleEl.textContent = '编辑任务'
    if (subtitleEl) subtitleEl.textContent = '修改当前任务的字段与属性，点击保存即可生效。'

    fTitle.value = task.title || ''
    fDesc.value = task.desc || ''
    fUrl.value = task.url || ''
    fPlaceholder.checked = Boolean(task.isPlaceholder)
    rotationRuleId = task.rotationRuleId || null
    if (fRotEnabled) fRotEnabled.checked = Boolean(rotationRuleId)

    const cfg = task.checkConfig
    fCheck.checked = Boolean(cfg?.enabled)
    fCheckCategory.value = cfg?.category || ''
    fCheckCount.value = cfg?.targetCount || 7
  } else {
    if (titleEl) titleEl.textContent = '添加新任务'
    if (subtitleEl) subtitleEl.textContent = '填写下方字段以创建一条新的工作流卡片。'

    fTitle.value = ''
    fDesc.value = ''
    fUrl.value = ''
    fPlaceholder.checked = false
    fCheck.checked = false
    fCheckCategory.value = ''
    fCheckCount.value = 7
    if (fRotEnabled) fRotEnabled.checked = false
  }

  applyCheckFieldVisibility()
  applyRotationEnabledUI()
  renderRotationSummary(rotationRuleId)
  openModal('taskform')

  setTimeout(() => {
    if (fTitle && !fTitle.value) fTitle.focus({ preventScroll: true })
  }, 220)
  DBG('taskform:open', { mode, taskId, rotationRuleId })
}

export function closeTaskForm() {
  currentMode = 'add'
  currentEditingId = null
  closeModal('taskform')
}

/* ============================================================
 * 提交：原子保存任务 + 引用已存在的轮换规则
 * ============================================================ */
export function handleTaskFormSubmit(event) {
  if (event && typeof event.preventDefault === 'function') event.preventDefault()
  clearTaskFormErrors()

  const fTitle = $('taskform-title-input')
  const fDesc = $('taskform-desc')
  const fUrl = $('taskform-url')
  const fPlaceholder = $('taskform-placeholder')
  const fCheck = $('taskform-check')
  const fCheckCategory = $('taskform-check-category')
  const fCheckCount = $('taskform-check-count')
  const rotationIdInput = $('taskform-rotation-id')
  const fRotEnabled = $('taskform-rotation-enabled')

  if (!fTitle || !fDesc || !fUrl) return

  const title = (fTitle.value || '').trim()
  const desc = (fDesc.value || '').trim()
  const urlRaw = (fUrl.value || '').trim()
  const url = urlRaw || null
  const isPlaceholder = Boolean(fPlaceholder?.checked)

  if (!title) {
    setFieldError('taskform-title-input', '任务名称不能为空。')
    setTimeout(() => fTitle.focus(), 80)
    return
  }

  if (url) {
    try {
      // eslint-disable-next-line no-new
      new URL(url)
    } catch (_) {
      setFieldError('taskform-url', 'URL 格式不合法，请检查开头是否为 http:// 或 https://。')
      setTimeout(() => fUrl.focus(), 80)
      return
    }
  }

  const rotEnabled = Boolean(fRotEnabled?.checked)
  const rotationRuleId = rotEnabled ? (rotationIdInput?.value || '') : ''
  const validRotationId = rotationRuleId && findRotationRule(rotationRuleId) ? rotationRuleId : null
  const hasDynamicTag = Boolean(validRotationId)
  const type = url ? 'jump_and_check' : 'check_only'

  const checkConfig = fCheck?.checked
    ? normalizeCheckConfig({
        enabled: true,
        category: fCheckCategory?.value,
        targetCount: fCheckCount?.value
      })
    : null

  if (currentMode === 'edit' && currentEditingId) {
    const workflows = getWorkflows()
    const idx = workflows.findIndex((t) => t.id === currentEditingId)
    if (idx === -1) {
      showToast('编辑失败：任务已不存在。')
      closeTaskForm()
      return
    }
    const updated = {
      ...workflows[idx],
      title,
      desc: desc || null,
      url,
      type,
      isPlaceholder,
      hasDynamicTag,
      rotationRuleId: validRotationId,
      checkConfig
    }
    replaceTaskStore(currentEditingId, updated)
    showToast('任务已更新。')
  } else {
    const task = createTask({
      title,
      desc: desc || null,
      url,
      type,
      isPlaceholder,
      hasDynamicTag,
      rotationRuleId: validRotationId,
      checkConfig
    })
    addTaskStore(task)
    showToast('已添加新任务。')
  }

  renderWorkflow()
  renderEditorList()
  closeTaskForm()
}

/* ============================================================
 * 供 settings/index.js 在初始化时调用一次的事件绑定
 *   - 关闭 / 取消 / 提交
 *   - rotation 二级页面返回
 *   - 检查开关、轮换链接、轮换启用开关
 *   - rotation 模态自身的事件
 * ============================================================ */
export function bindTaskFormEvents() {
  const closeBtn = $('taskform-close')
  const scrim = document.querySelector('#taskform-modal .modal__scrim')
  const cancelBtn = $('taskform-cancel')
  const form = $('taskform-form')
  const rotationBack = document.querySelector('#taskform-rotation-modal .modal__back')

  if (closeBtn && !closeBtn.dataset.bound) {
    closeBtn.dataset.bound = '1'
    closeBtn.addEventListener('click', () => closeTaskForm())
  }
  if (scrim && !scrim.dataset.bound) {
    scrim.dataset.bound = '1'
    scrim.addEventListener('click', () => closeTaskForm())
  }
  if (cancelBtn && !cancelBtn.dataset.bound) {
    cancelBtn.dataset.bound = '1'
    cancelBtn.addEventListener('click', () => closeTaskForm())
  }
  if (form && !form.dataset.bound) {
    form.dataset.bound = '1'
    form.addEventListener('submit', handleTaskFormSubmit)
  }
  if (rotationBack && !rotationBack.dataset.bound) {
    rotationBack.dataset.bound = '1'
    rotationBack.addEventListener('click', () => replaceModal('rotation', 'taskform'))
  }

  bindCheckSwitch()
  bindRotationEnabledSwitch()
  bindRotationLink()
  bindRotationModalEvents()
}

/* ============================================================
 * 由 rotation-editor.js 在保存/删除规则后回调，写回 ID
 * ============================================================ */
export function syncRotationRuleId(ruleId) {
  const enabledInput = $('taskform-rotation-enabled')
  if (ruleId && enabledInput && !enabledInput.checked) {
    enabledInput.checked = true
    applyRotationEnabledUI()
  }
  renderRotationSummary(ruleId || null)
}

export function isTaskFormDirty() {
  if (!$('taskform-modal') || $('taskform-modal').hidden) return false
  const fTitle = $('taskform-title-input')
  return Boolean(fTitle && (fTitle.value || '').trim())
}

export function getRotationRulesSync() {
  return getRotationRules()
}

import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N, t } from '../locales.js'
import {
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
  createRotationRule,
  createEmptyDayEntry
} from '../config/rotation-rules.js'
import {
  getRotationRules,
  findRotationRule,
  upsertRotationRule,
  deleteRotationRule
} from '../workflow/rotation-store.js'
import { uploadToGist } from '../backup/gist-sync.js'
import { $ } from '../utils/dom-utils.js'
import {
  openModal,
  closeModal,
  replaceModal,
  openConfirmDialog
} from './modal.js'
import { syncRotationRuleId } from './task-form.js'

/**
 * RotationEditor —— 轮换预设二级编辑器
 *
 *  由任务表单的「启用轮换」开关后的链接行触发。
 *
 *  顶部「预设」列表：列出全部轮换规则，单选（radio 风格）。
 *  「+ 新建预设」按钮 → 新建并选中。
 *  选中后下方显示「规则名称」输入框 + 7 天每日配置（全部展开）。
 *  底部「保存」/「删除」按钮：
 *    - 保存：写入当前预设
 *    - 删除：删除当前预设（如有任务在使用，则一并取消关联）
 */

let currentRule = null

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]))
}

function loadRule(ruleId) {
  if (ruleId) {
    const found = findRotationRule(ruleId)
    if (found) return JSON.parse(JSON.stringify(found))
  }
  const all = getRotationRules()
  if (all.length) return JSON.parse(JSON.stringify(all[0]))
  return createRotationRule({ name: I18N.workflow.newRotationRule })
}

function writeBack() {
  if (!currentRule) return
  const nameInput = $('rotation-rule-name')
  if (nameInput) currentRule.name = (nameInput.value || '').trim() || I18N.workflow.rotationUntitled
}

function applyFormValues() {
  const nameInput = $('rotation-rule-name')
  if (nameInput) nameInput.value = currentRule.name || ''
}

/* ============================================================
 * 预设列表
 * ============================================================ */
function summarizeDay(entry) {
  if (!entry) return I18N.workflow.notConfigured
  if (entry.disabled) return I18N.common.restDay
  return entry.label || I18N.common.untitled
}

function summarizeRule(rule) {
  if (!rule || !Array.isArray(rule.days)) return I18N.workflow.emptyRule
  const samples = WEEKDAY_ORDER.slice(0, 3).map((idx) => summarizeDay(rule.days[idx]))
  return samples.filter(Boolean).join(' · ')
}

function renderPresetList() {
  const list = $('rotation-preset-list')
  if (!list) return
  const rules = getRotationRules()
  list.replaceChildren()
  if (!rules.length) {
    const empty = document.createElement('div')
    empty.className = 'rotation-preset-empty'
    empty.textContent = I18N.workflow.noPresetYet
    list.appendChild(empty)
    return
  }
  for (const rule of rules) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'rotation-preset-row'
    btn.setAttribute('role', 'radio')
    btn.dataset.ruleId = rule.id
    const checked = currentRule && currentRule.id === rule.id
    btn.setAttribute('aria-checked', String(Boolean(checked)))
    if (checked) btn.classList.add('is-selected')
    btn.innerHTML = `
      <span class="rotation-preset-row__radio" aria-hidden="true">
        <span class="rotation-preset-row__radio-dot"></span>
      </span>
      <span class="rotation-preset-row__body">
        <strong class="rotation-preset-row__name"></strong>
        <small class="rotation-preset-row__hint"></small>
      </span>`
    btn.querySelector('.rotation-preset-row__name').textContent = rule.name || I18N.workflow.rotationUntitled
    btn.querySelector('.rotation-preset-row__hint').textContent = summarizeRule(rule)
    list.appendChild(btn)
  }
}

function selectRule(ruleId, { silent = false } = {}) {
  const found = findRotationRule(ruleId)
  if (!found) {
    currentRule = null
    updateEditSection()
    renderPresetList()
    return
  }
  currentRule = JSON.parse(JSON.stringify(found))
  applyFormValues()
  renderSummaryList()
  renderPresetList()
  updateEditSection()
  if (!silent) DBG('rotation:select', { id: ruleId })
}

function createNewPreset() {
  const rule = createRotationRule({ name: t(I18N.workflow.newPresetCount, { count: getRotationRules().length + 1 }) })
  upsertRotationRule(rule)
  renderPresetList()
  selectRule(rule.id)
  DBG('rotation:create-preset', { id: rule.id })
  showToast(t(I18N.toast.workflow.presetCreated, { name: rule.name }))
}

function updateEditSection() {
  const sec = $('rotation-edit-section')
  if (!sec) return
  sec.hidden = !currentRule
}

/* ============================================================
 * 每日配置（始终展开 7 天）
 * ============================================================ */
function renderSummaryList() {
  const list = $('rotation-summary-list')
  if (!list || !currentRule) return
  list.replaceChildren()
  const todayIdx = new Date().getDay()

  for (const dayIdx of WEEKDAY_ORDER) {
    const entry = currentRule.days[dayIdx] || createEmptyDayEntry()
    const isToday = dayIdx === todayIdx
    const row = document.createElement('div')
    row.className = 'rot-day-row rot-day-row--edit'
    row.dataset.dayIdx = String(dayIdx)
    if (isToday) row.classList.add('is-today')
    if (entry.disabled) row.classList.add('is-disabled-day')
    row.innerHTML = `
      <div class="rot-day-row__head">
        <strong class="rot-day-row__day"></strong>
        ${isToday ? `<span class="rot-today-pill">${I18N.common.today}</span>` : ''}
      </div>
      <div class="rot-day-row__fields">
        <label class="rot-day-row__icon">
          <span class="material-symbols rot-icon-preview" aria-hidden="true"></span>
          <input type="text" data-rot-field="icon" placeholder="icon name" maxlength="40" />
        </label>
        <label class="rot-day-row__label">
          <input type="text" data-rot-field="label" placeholder="例如：今日专项：写作" maxlength="80" />
        </label>
        <label class="rot-switch">
          <input type="checkbox" data-rot-field="disabled" />
          <span class="rot-switch__track"><span class="rot-switch__thumb"></span></span>
          <small>${I18N.common.restDay}</small>
        </label>
      </div>`
    row.querySelector('.rot-day-row__day').textContent = WEEKDAY_LABELS[dayIdx]
    const iconInput = row.querySelector('[data-rot-field="icon"]')
    const iconPreview = row.querySelector('.rot-icon-preview')
    if (iconInput) iconInput.value = entry.icon || ''
    if (iconPreview) iconPreview.textContent = entry.icon || 'label'
    const labelInput = row.querySelector('[data-rot-field="label"]')
    if (labelInput) labelInput.value = entry.label || ''
    const disabledInput = row.querySelector('[data-rot-field="disabled"]')
    if (disabledInput) disabledInput.checked = Boolean(entry.disabled)
    list.appendChild(row)
  }
}

/* ============================================================
 * 事件绑定（一次性）
 * ============================================================ */
function bindPresetList() {
  const list = $('rotation-preset-list')
  if (!list || list.dataset.bound === '1') return
  list.dataset.bound = '1'
  list.addEventListener('click', (e) => {
    const row = e.target.closest('.rotation-preset-row')
    if (!row) return
    const id = row.dataset.ruleId
    if (id) selectRule(id)
  })
}

function bindNewPresetBtn() {
  const btn = $('rotation-preset-new')
  if (!btn || btn.dataset.bound === '1') return
  btn.dataset.bound = '1'
  btn.addEventListener('click', createNewPreset)
}

function bindSummaryList() {
  const list = $('rotation-summary-list')
  if (!list || list.dataset.bound === '1') return
  list.dataset.bound = '1'
  list.addEventListener('input', (e) => {
    const target = e.target
    const dayRow = target.closest('.rot-day-row')
    if (!dayRow || !currentRule) return
    const dayIdx = Number(dayRow.dataset.dayIdx)
    const field = target.dataset?.rotField
    if (!field || !Number.isInteger(dayIdx)) return
    const entry = currentRule.days[dayIdx]
    if (!entry) return
    if (field === 'icon') {
      entry.icon = (target.value || '').trim() || 'label'
      const preview = dayRow.querySelector('.rot-icon-preview')
      if (preview) preview.textContent = entry.icon
    } else if (field === 'label') {
      entry.label = target.value || ''
    } else if (field === 'disabled') {
      entry.disabled = Boolean(target.checked)
      entry.variant = entry.disabled ? 'muted' : 'accent'
      dayRow.classList.toggle('is-disabled-day', entry.disabled)
    }
  })
}

function bindHeaderInputs() {
  const nameInput = $('rotation-rule-name')
  if (nameInput && !nameInput.dataset.bound) {
    nameInput.dataset.bound = '1'
    nameInput.addEventListener('input', () => {
      if (currentRule) currentRule.name = nameInput.value || ''
    })
  }
}

/* ============================================================
 * 保存 / 删除
 * ============================================================ */
async function handleRotationSave() {
  if (!currentRule) {
    await replaceModal('rotation', 'taskform', { opener: $('rotation-save') })
    return
  }
  writeBack()
  const name = (currentRule.name || '').trim() || I18N.workflow.rotationUntitled
  currentRule.name = name
  const id = upsertRotationRule(currentRule)
  syncRotationRuleId(id)
  showToast(t(I18N.toast.workflow.presetSaved, { name }))
  DBG('rotation:save', { id, name })
  await replaceModal('rotation', 'taskform', { opener: $('rotation-save') })
}

async function handleRotationDelete() {
  if (!currentRule || !currentRule.id) {
    await replaceModal('rotation', 'taskform', { opener: $('rotation-save') })
    return
  }
  const ok = await openConfirmDialog({
    title: I18N.workflow.deletePresetTitle,
    message: t(I18N.workflow.deletePresetMsg, { name: currentRule.name || I18N.common.untitled }),
    confirmText: I18N.common.delete,
    cancelText: I18N.common.cancel,
    danger: true
  })
  if (!ok) return
  const removedId = currentRule.id
  deleteRotationRule(removedId)
  syncRotationRuleId(null)
  showToast(I18N.toast.workflow.presetDeleted)
  DBG('rotation:delete', removedId)
  const next = getRotationRules()
  await replaceModal('rotation', 'taskform', { opener: $('rotation-save') })
  if (!next.find((r) => r.id === removedId) && next.length === 0) {
    // 全部删除：清理任务表单的选择
    syncRotationRuleId(null)
  }
  
  // 添加Gist上传触发
  await uploadToGist()
}

function bindActionButtons() {
  const saveBtn = $('rotation-save')
  if (saveBtn && !saveBtn.dataset.bound) {
    saveBtn.dataset.bound = '1'
    saveBtn.addEventListener('click', handleRotationSave)
  }
  const root = $('taskform-rotation-modal')
  if (root && !root.dataset.deleteBound) {
    root.dataset.deleteBound = '1'
    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.id = 'rotation-delete'
    delBtn.className = 'btn btn--text btn--danger'
    delBtn.innerHTML = `<span class="material-symbols" aria-hidden="true">delete</span>${I18N.workflow.deletePresetBtn}`
    const footer = root.querySelector('.modal__footer--mobile')
    if (footer) {
      delBtn.style.marginRight = 'auto'
      footer.prepend(delBtn)
    }
    delBtn.addEventListener('click', handleRotationDelete)
  }
}

export function bindRotationModalEvents() {
  bindPresetList()
  bindNewPresetBtn()
  bindSummaryList()
  bindHeaderInputs()
  bindActionButtons()
}

export function openRotationModal(ruleId) {
  currentRule = null
  if (ruleId) {
    const found = findRotationRule(ruleId)
    if (found) currentRule = JSON.parse(JSON.stringify(found))
  }
  if (!currentRule) {
    const all = getRotationRules()
    if (all.length) currentRule = JSON.parse(JSON.stringify(all[0]))
  }
  if (!currentRule) currentRule = createRotationRule({ name: I18N.workflow.newRotationRule })
  applyFormValues()
  renderPresetList()
  renderSummaryList()
  updateEditSection()
  openModal('rotation')
  DBG('rotation:open', { ruleId, name: currentRule?.name })
}

export function closeRotationModal() {
  currentRule = null
  closeModal('rotation')
}

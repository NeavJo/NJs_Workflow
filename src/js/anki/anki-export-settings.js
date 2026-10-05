import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N, t } from '../locales.js'
import { getMemoTags, onMemoTagsChange } from '../memo/memo-store.js'
import {
  getAnkiExportSettings,
  commitAnkiExportSettings,
  onAnkiExportSettingsChange
} from './anki-export-store.js'
import { $ } from '../utils/dom-utils.js'
import { createGuard } from '../utils/guard.js'
import { getCurrentSettingsView } from '../settings/navigation.js'
import {
  DEFAULT_ANKI_EXPORT_FIELD_NAMES,
  normalizeAnkiModelId,
  normalizeAnkiExportFieldNames,
  normalizeAnkiExportTemplateName,
  validateAnkiExportFieldNames
} from '../config/storage-config.js'

const guardAnkiExportSettings = createGuard('ankiExportSettingsEventsBound')

function fieldNamesErrorText(result) {
  if (!result) return null
  if (result.reason === 'duplicate') return t(I18N.toast.anki.apkgFieldNamesDuplicate, { name: result.name })
  return I18N.toast.anki.apkgFieldNamesEmpty
}

/**
 * 解析用户输入的字段名（逗号分隔）：
 *  - 空输入回落到 fallback（默认字段名）。
 *  - 否则完全以用户输入为准，保留其字段数量与顺序（不再固定 3 个）。
 *    目标笔记类型的字段数必须与之逐一对应（Anki 的 equal_schema 会按数量+名称比对），
 *    因此不能截断或补齐到固定长度，否则字段数不符会触发 Anki 克隆出新类型。
 */
function parseFieldNames(raw, fallback) {
  const text = typeof raw === 'string' ? raw : ''
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) {
    return normalizeAnkiExportFieldNames(fallback || DEFAULT_ANKI_EXPORT_FIELD_NAMES)
  }
  return normalizeAnkiExportFieldNames(parts)
}

/**
 * APKG 导出配置设置页：默认卡组/模型 + 按 memo 标签覆盖。
 *  - 渲染：从 store 读取配置，填充静态默认输入框和动态标签输入框。
 *  - 保存：读取所有输入框，构造 tagConfigs 后通过 commitAnkiExportSettings 持久化。
 *  - 订阅：配置被外部修改（备份恢复、Gist 拉取）时重新渲染，但不会覆盖用户正在编辑的输入框。
 */

/**
 * 渲染 APKG 导出设置页。
 * 调用时机：进入设置页、保存成功、外部配置变更。
 * 不重置标签输入框中的值，避免用户在编辑过程中被意外清场。
 */
export function renderAnkiExportSettings() {
  const settings = getAnkiExportSettings()
  const defaultDeckEl = $('anki-export-deck-default')
  const defaultModelEl = $('anki-export-model-default')
  const defaultModelIdEl = $('anki-export-modelid-default')
  const defaultFieldNamesEl = $('anki-export-fieldnames-default')
  const defaultTemplateNameEl = $('anki-export-templatename-default')

  if (defaultDeckEl) defaultDeckEl.value = settings.defaultConfig.deckName
  if (defaultModelEl) defaultModelEl.value = settings.defaultConfig.modelName
  if (defaultModelIdEl) defaultModelIdEl.value = settings.defaultConfig.modelId || ''
  if (defaultFieldNamesEl) defaultFieldNamesEl.value = (settings.defaultConfig.fieldNames || []).join(', ')
  if (defaultTemplateNameEl) defaultTemplateNameEl.value = settings.defaultConfig.templateName || ''

  const tagContainer = $('anki-export-tag-configs')
  if (!tagContainer) return

  const tags = getMemoTags()

  // 标签配置是独立的覆盖项，不与生词记事本当前筛选标签绑定。
  // 设置页只显示每个标签自身是否已配置，避免把当前筛选状态误解为导出使用状态。
  tagContainer.innerHTML = ''

  if (!tags.length) {
    const empty = document.createElement('p')
    empty.className = 'anki-export-tag-configs__empty'
    empty.textContent = I18N.settings.ankiExportTagNone
    tagContainer.appendChild(empty)
    return
  }

  for (const tag of tags) {
    const tagId = tag.id
    const tagLabel = tag.name.replace(/^#/, '')
    const config = settings.tagConfigs[tagId]

    const item = document.createElement('div')
    item.className = 'anki-export-tag-item'
    item.dataset.tagId = tagId

    // 标签名 + 配置状态；状态只由该标签是否存在独立配置决定。
    const nameRow = document.createElement('div')
    nameRow.className = 'anki-export-tag-item__name'
    nameRow.textContent = tagLabel
    const badge = document.createElement('span')
    badge.className = 'anki-export-tag-item__badge'
    badge.textContent = config ? I18N.settings.ankiExportTagConfigured : I18N.settings.ankiExportTagNotConfigured
    nameRow.appendChild(badge)
    item.appendChild(nameRow)

    // 未单独配置的标签：提示导出时将回落到默认配置。
    if (!config) {
      const hint = document.createElement('p')
      hint.className = 'anki-export-tag-item__hint'
      hint.textContent = I18N.settings.ankiExportTagNoneHint
      item.appendChild(hint)
    }

    // 卡组输入框：标签 + 输入框成对放入一个 row，与默认配置卡片保持一致的横向布局。
    // 不能把 label 和 input 作为 tag-item 的独立子节点，否则列布局下
    // .anki-export-label 的 flex-basis(120px) 会体现在高度上，造成大片空白。
    const deckRow = document.createElement('div')
    deckRow.className = 'anki-export-card__row'
    const deckLabel = document.createElement('label')
    deckLabel.className = 'anki-export-label'
    const deckInputId = `anki-export-deck-${tagId}`
    deckLabel.htmlFor = deckInputId
    deckLabel.textContent = I18N.settings.ankiExportDeckLabel
    const deckInput = document.createElement('input')
    deckInput.type = 'text'
    deckInput.id = deckInputId
    deckInput.className = 'anki-export-input'
    deckInput.placeholder = settings.defaultConfig.deckName
    deckInput.value = config?.deckName || ''
    deckInput.autocomplete = 'off'
    deckRow.appendChild(deckLabel)
    deckRow.appendChild(deckInput)
    item.appendChild(deckRow)

    // 模型输入框：同样成对放入 row。
    const modelRow = document.createElement('div')
    modelRow.className = 'anki-export-card__row'
    const modelLabel = document.createElement('label')
    modelLabel.className = 'anki-export-label'
    const modelInputId = `anki-export-model-${tagId}`
    modelLabel.htmlFor = modelInputId
    modelLabel.textContent = I18N.settings.ankiExportModelLabel
    const modelInput = document.createElement('input')
    modelInput.type = 'text'
    modelInput.id = modelInputId
    modelInput.className = 'anki-export-input'
    modelInput.placeholder = settings.defaultConfig.modelName
    modelInput.value = config?.modelName || ''
    modelInput.autocomplete = 'off'
    modelRow.appendChild(modelLabel)
    modelRow.appendChild(modelInput)
    item.appendChild(modelRow)

    // 笔记类型 ID：纯数字，填了才能复用 Anki 已有笔记类型（Anki 按内部 ID 而非名称匹配）。
    item.appendChild(buildTagRow({
      label: I18N.settings.ankiExportModelIdLabel,
      inputId: `anki-export-modelid-${tagId}`,
      placeholder: settings.defaultConfig.modelId || '',
      value: config?.modelId || '',
      inputMode: 'numeric'
    }))

    // 字段名：逗号分隔，按顺序对应 F1/F2/F3，须与目标笔记类型字段名一致。
    item.appendChild(buildTagRow({
      label: I18N.settings.ankiExportFieldNamesLabel,
      inputId: `anki-export-fieldnames-${tagId}`,
      placeholder: (settings.defaultConfig.fieldNames || []).join(', '),
      value: (config?.fieldNames || []).join(', ')
    }))

    // 模板名：须与目标笔记类型的模板名一致，否则 Anki 会追加模板多出一张卡。
    item.appendChild(buildTagRow({
      label: I18N.settings.ankiExportTemplateNameLabel,
      inputId: `anki-export-templatename-${tagId}`,
      placeholder: settings.defaultConfig.templateName || '',
      value: config?.templateName || ''
    }))

    tagContainer.appendChild(item)
  }
}

/**
 * 构造标签级配置的「label + input」一行。
 * 与上方默认卡片保持一致的横向布局：label 与 input 必须成对放入 row，
 * 否则列布局下 .anki-export-label 的 flex-basis 会撑出大片空白。
 */
function buildTagRow({ label, inputId, placeholder, value, inputMode }) {
  const row = document.createElement('div')
  row.className = 'anki-export-card__row'
  const labelEl = document.createElement('label')
  labelEl.className = 'anki-export-label'
  labelEl.htmlFor = inputId
  labelEl.textContent = label
  const input = document.createElement('input')
  input.type = 'text'
  input.id = inputId
  input.className = 'anki-export-input'
  input.placeholder = placeholder || ''
  input.value = value || ''
  input.autocomplete = 'off'
  if (inputMode) input.inputMode = inputMode
  row.appendChild(labelEl)
  row.appendChild(input)
  return row
}

/**
 * 保存当前 APKG 导出配置：
 *  1. 读取默认卡组/模型
 *  2. 遍历标签输入框，收集非空的 tagConfigs
 *  3. commitAnkiExportSettings 持久化，成功后重新渲染并提示
 */
export function saveAnkiExportSettingsFromInputs() {
  const settings = getAnkiExportSettings()
  const defaultDeckEl = $('anki-export-deck-default')
  const defaultModelEl = $('anki-export-model-default')
  const defaultModelIdEl = $('anki-export-modelid-default')
  const defaultFieldNamesEl = $('anki-export-fieldnames-default')
  const defaultTemplateNameEl = $('anki-export-templatename-default')

  const nextDefault = {
    deckName: (defaultDeckEl?.value || '').trim() || settings.defaultConfig.deckName,
    modelName: (defaultModelEl?.value || '').trim() || settings.defaultConfig.modelName,
    modelId: normalizeAnkiModelId(defaultModelIdEl?.value || ''),
    fieldNames: parseFieldNames(defaultFieldNamesEl?.value, settings.defaultConfig.fieldNames),
    templateName: normalizeAnkiExportTemplateName(defaultTemplateNameEl?.value || '')
  }

  const defaultFieldError = fieldNamesErrorText(validateAnkiExportFieldNames(nextDefault.fieldNames))
  if (defaultFieldError) {
    showToast(defaultFieldError)
    DBG('anki-export:save:invalid-default-fieldnames')
    return
  }

  // 收集标签级覆盖配置：只保留有实际填写的字段，留空则回落到默认
  const tagConfigs = {}
  const tagItems = document.querySelectorAll('#anki-export-tag-configs .anki-export-tag-item')
  for (const item of tagItems) {
    const tagId = item.dataset.tagId
    if (!tagId) continue
    // tagId 形如 "#Deutsch/Anki"，含 # 与 / ，必须用 CSS.escape 转义，
    // 否则 querySelector 会因非法选择器抛 SyntaxError，导致整页保存失败。
    const escapedTagId = CSS.escape(tagId)
    const deckInput = item.querySelector(`#anki-export-deck-${escapedTagId}`)
    const modelInput = item.querySelector(`#anki-export-model-${escapedTagId}`)
    const modelIdInput = item.querySelector(`#anki-export-modelid-${escapedTagId}`)
    const fieldNamesInput = item.querySelector(`#anki-export-fieldnames-${escapedTagId}`)
    const templateNameInput = item.querySelector(`#anki-export-templatename-${escapedTagId}`)
    const deckName = (deckInput?.value || '').trim()
    const modelName = (modelInput?.value || '').trim()
    const modelId = normalizeAnkiModelId(modelIdInput?.value || '')
    const fieldNamesRaw = (fieldNamesInput?.value || '').trim()
    const templateNameRaw = (templateNameInput?.value || '').trim()
    if (deckName || modelName || modelId || fieldNamesRaw || templateNameRaw) {
      const fieldNames = fieldNamesRaw ? parseFieldNames(fieldNamesRaw, nextDefault.fieldNames) : nextDefault.fieldNames
      const fieldError = fieldNamesErrorText(validateAnkiExportFieldNames(fieldNames))
      if (fieldError) {
        showToast(fieldError)
        DBG('anki-export:save:invalid-tag-fieldnames', { tagId })
        return
      }
      tagConfigs[tagId] = {
        deckName: deckName || nextDefault.deckName,
        modelName: modelName || nextDefault.modelName,
        modelId: modelId || nextDefault.modelId,
        fieldNames,
        templateName: templateNameRaw || nextDefault.templateName
      }
    }
  }

  const result = commitAnkiExportSettings({
    defaultConfig: nextDefault,
    tagConfigs
  }, { reason: 'anki-export-settings:save' })

  if (!result.ok) {
    showToast(I18N.toast.anki.apkgSettingsSaveFailed)
    DBG('anki-export:save:fail')
    return
  }

  renderAnkiExportSettings()
  showToast(I18N.toast.anki.apkgSettingsSaved)
  DBG('anki-export:save:ok', { tagConfigCount: Object.keys(tagConfigs).length })
}

/**
 * 幂等绑定 APKG 导出设置页事件。
 *  1. 保存按钮 click → saveAnkiExportSettingsFromInputs
 *  2. 外部配置变更订阅 → 重新渲染（仅 external: true，避免自身操作二次刷新）
 *  3. memo 标签增删改订阅 → 仅在设置页停留在 APKG 子页时重渲染，避免用户正编辑时被清场
 */
export function bindAnkiExportSettingsEvents() {
  if (guardAnkiExportSettings.is()) return
  guardAnkiExportSettings.set()

  const saveBtn = $('btn-anki-export-save')
  saveBtn?.addEventListener('click', saveAnkiExportSettingsFromInputs)

  // 外部变更（备份导入、Gist 拉取）触发重新渲染
  onAnkiExportSettingsChange((data) => {
    if (data && data.reason && data.reason.startsWith('external')) {
      renderAnkiExportSettings()
    }
  })

  // 标签列表变化：用户新增/删除/改名标签后，配置表单需同步增删条目。
  // 仅在当前正处于 APKG 导出子页时重渲染，避免用户编辑其它页面时被无谓刷新。
  onMemoTagsChange(() => {
    if (getCurrentSettingsView() === 'anki-export') {
      renderAnkiExportSettings()
    }
  })
}

export default {
  renderAnkiExportSettings,
  saveAnkiExportSettingsFromInputs,
  bindAnkiExportSettingsEvents
}

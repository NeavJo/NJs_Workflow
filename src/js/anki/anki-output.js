import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N, t } from '../locales.js'
import { getTodayDateString } from '../core/date.js'
import { triggerDownload } from '../backup/snapshot.js'
import { $ } from '../utils/dom-utils.js'
import { createGuard } from '../utils/guard.js'
import { getSelectedMemoTag, getMemoTags } from '../memo/memo-store.js'
import { getAnkiSourceTag, getAnkiInputEdited } from './anki-store.js'
import { generateApkg } from './anki-apkg.js'
import { getAnkiExportConfigForTag, hasAnkiExportTagConfig, onAnkiExportSettingsChange } from './anki-export-store.js'
import { validateAnkiExportFieldNames } from '../config/storage-config.js'

/**
 * Anki 输出区：AI 返回结果解析与分类卡片渲染
 *  - parseAnkiOutput：按 `=== [分类名] ===` 行标记切割纯文本为有序分类数组。
 *  - composeAnkiOutput：反向拼接，保证 parse → compose 往返一致（全局复制 / 导出用）。
 *  - renderAnkiCards：按解析结果动态生成分类卡片（标签 + 可编辑 textarea + 快捷按钮组）。
 *  - 卡片级与全局复制 / 导出；卡片按钮走事件委托，DOM 为唯一数据源。
 */

// 文件名前缀：全量导出标记为可整体导入的合并文件，单分类导出标记为按类拆分。
const IMPORT_TXT_FILENAME_PREFIX = 'Import_'
const EXPORT_TXT_FILENAME_PREFIX = 'Export_'
// APKG 文件名格式遵循计划约定：Deck_<标签>_YYYYMMDD.apkg
const APKG_FILENAME_PREFIX = 'Deck_'
// "异常词汇"是提示词约定的固定分类名，仅精确匹配，避免误伤含"异常"字样的用户自定义分类。
const ABNORMAL_CATEGORY_NAME = '异常词汇'

/**
 * 判断某分类是否为约定中的"异常词汇"分类（精确匹配，非包含匹配）。
 */
function isAbnormalCategory(name) {
  return String(name || '') === ABNORMAL_CATEGORY_NAME
}

/**
 * 解析本次 Anki 导出应使用的"来源标签"：
 *  优先取"最近一次从某条 memo 填充进输入框时记录的来源标签"（getAnkiSourceTag），
 *  它精确对应"正在处理的这批生词真正属于哪个标签"；
 *  若用户是手动粘贴/编辑输入框（从未填充过来源），则回退到生词本当前选中标签，
 *  保持旧行为不变，避免空标签导致配置解析失败。
 */
function getCurrentSourceTagId() {
  return String(getAnkiSourceTag() || getSelectedMemoTag() || '')
}

/**
 * 获取当前来源标签的显示名（去 # 前缀），用于拼接导出文件名。
 * 未配置或无法匹配时返回空字符串，由调用方做兜底。
 */
function getSourceTagDisplayName() {
  const tagId = getCurrentSourceTagId()
  if (!tagId) return ''
  const tags = getMemoTags()
  const found = tags.find((t) => t.id === tagId)
  return found?.name ? found.name.replace(/^#/, '') : tagId.replace(/^#/, '')
}

function getCurrentExportConfig() {
  // 关键：按"内容来源标签"而非"生词本当前筛选标签"解析配置，
  // 修复"标签2内容误用标签1配置"的根因。
  const tagId = getCurrentSourceTagId()
  return {
    tagId,
    tagConfig: getAnkiExportConfigForTag(tagId),
    hasTagConfig: hasAnkiExportTagConfig(tagId)
  }
}

function notifyDefaultTagConfig(tagId, hasTagConfig) {
  if (tagId && !hasTagConfig) {
    showToast(I18N.settings.ankiExportTagNoneHint, { status: 'info' })
  }
}

/**
 * APKG 业务级生成互斥锁：全量导出与单分类导出共享同一把锁。
 * 按钮级 disabled 只覆盖各自按钮，无法阻止"全量生成中再点单分类"，因此必须
 * 在业务层拒绝并发——否则会同时建两份 SQLite 并同步 ZIP，造成内存峰值与卡顿。
 * 策略：已有导出进行时直接拒绝新请求（不排队、不取消），并由 finally 释放。
 */
let apkgGenerating = false

/**
 * 将 APKG 生成错误的稳定 code 映射为中文提示；未知 code 归为通用失败。
 * 仅按 code 分支，不解析错误文本，也不输出输入内容 / 敏感配置。
 */
function resolveApkgErrorToast(code) {
  switch (code) {
    case 'engine-load-failed':
      return I18N.toast.anki.apkgEngineLoadFailed
    case 'input-too-large':
      return I18N.toast.anki.apkgInputTooLarge
    case 'note-limit-exceeded':
      return I18N.toast.anki.apkgNoteLimitExceeded
    case 'empty-export':
      return I18N.toast.anki.apkgEmptyExport
    case 'invalid-model-id':
      return I18N.toast.anki.apkgInvalidModelId
    default:
      return I18N.toast.anki.apkgFailed
  }
}

/**
 * 渲染输入区"内容来源 + APKG 配置"状态条：
 *  让导出前即可预见"这批内容来自哪个标签、将使用哪套卡组/模型"，
 *  避免用户导出后才发现配置被误带偏（标签2误用标签1配置）。
 *
 *  设计约束（与项目状态链路对齐）：
 *  - 纯渲染、幂等：DOM 元素不存在时安全返回，可被反复调用（processInAnki、
 *    input 事件、导出配置变更都会触发）。
 *  - 数据来源 = getAnkiSourceTag（来源标签）+ getAnkiInputEdited（是否手动改动）。
 *    两者都不落盘，刷新后回到"跟随生词本选中标签"的兜底语义。
 */
export function refreshAnkiSourceStatus() {
  const el = $('anki-source-status')
  if (!el) return
  const { tagId, hasTagConfig } = getCurrentExportConfig()
  const sourceTag = getAnkiSourceTag()
  const name = getSourceTagDisplayName()
  const edited = getAnkiInputEdited()

  el.replaceChildren()

  // 来源标签 chip：无来源时提示"将跟随生词本当前筛选标签"。
  const chip = document.createElement('span')
  chip.className = 'anki-source-status__chip'
  const chipIcon = document.createElement('span')
  chipIcon.className = 'material-symbols'
  chipIcon.setAttribute('aria-hidden', 'true')
  chipIcon.textContent = 'sell'
  chip.append(chipIcon)

  if (sourceTag && name) {
    chip.append(Object.assign(document.createElement('span'), { textContent: name }))
    chip.classList.add('is-tagged')
  } else if (sourceTag) {
    // 标签 ID 存在但查不到显示名（标签可能已删除）：仍按来源标签解析配置。
    chip.append(Object.assign(document.createElement('span'), { textContent: tagId.replace(/^#/, '') || tagId }))
    chip.classList.add('is-tagged')
  } else {
    chip.append(Object.assign(document.createElement('span'), { textContent: I18N.anki.sourceTagFollowsMemo }))
    chip.classList.add('is-follow')
  }
  el.append(chip)

  // 配置去向说明：区分"按标签配置"与"回落默认"。
  const cfg = document.createElement('span')
  cfg.className = 'anki-source-status__config'
  const tagConfig = getAnkiExportConfigForTag(tagId)
  const deck = tagConfig?.deckName || ''
  if (!tagId || !hasTagConfig) {
    cfg.textContent = t(I18N.anki.sourceUsesDefault, { deck })
  } else {
    cfg.textContent = t(I18N.anki.sourceUsesTagConfig, { name, deck })
  }
  el.append(cfg)

  // 手动改动标记：提醒来源标签可能已漂移，但仍按最近填充来源导出。
  if (edited) {
    const warn = document.createElement('span')
    warn.className = 'anki-source-status__edited'
    warn.textContent = I18N.anki.sourceEdited
    el.append(warn)
  }
}

/** 幂等订阅导出配置变更 → 重渲染来源状态条（标签配置增删改后立即反映）。 */
const guardSourceStatus = createGuard('ankiSourceStatusSubscribed')
function subscribeAnkiSourceStatus() {
  if (guardSourceStatus.is()) return
  guardSourceStatus.set()
  onAnkiExportSettingsChange(() => refreshAnkiSourceStatus())
}

export function parseAnkiOutput(rawText) {
  const raw = typeof rawText === 'string' ? rawText : ''
  const re = /^===\s*(.*?)\s*===$/gm
  const sections = []
  const index = new Map()

  const push = (name, text) => {
    const key = name
    const prev = index.get(key)
    if (prev) {
      prev.text = prev.text ? `${prev.text}\n${text}` : text
      return
    }
    const section = { name, text }
    sections.push(section)
    index.set(key, section)
  }

  let currentName = null
  let lastEnd = 0
  let match
  while ((match = re.exec(raw)) !== null) {
    const body = raw.slice(lastEnd, match.index).trim()
    if (currentName === null) {
      if (body) push(I18N.anki.uncategorized, body)
    } else if (body) {
      push(currentName, body)
    }
    currentName = (match[1] || '').trim() || I18N.anki.uncategorized
    lastEnd = re.lastIndex
  }
  const tail = raw.slice(lastEnd).trim()
  if (tail) {
    push(currentName === null ? I18N.anki.uncategorized : currentName, tail)
  }
  return sections
}

export function composeAnkiOutput(sections) {
  const list = Array.isArray(sections) ? sections : []
  return list.map((s) => `=== ${s.name} ===\n${s.text}`).join('\n')
}

/**
 * 文件名清洗：把 Windows / 主流系统文件名不支持的字符统一替换为下划线（而非删除），
 * 以保留原本的层级可读性（如 `Deutsch/积累` → `Deutsch_积累`，而非误读为 `Deutsch积累`）。
 */
function sanitizeFilename(name) {
  const cleaned = String(name || '')
    // 非法字符（\ / : * ? " < > |）一律替换为下划线。
    .replace(/[\\/:*?"<>|]/g, '_')
    // 控制字符同样替换为下划线，避免不可见字符污染文件名。
    .replace(/[\u0000-\u001f]/g, '_')
    // 合并连续下划线，避免出现 `Deutsch__积累` 这类冗余分隔符。
    .replace(/_+/g, '_')
    // 文件名不允许以点、空格或下划线结尾（Windows 会截断或报错）。
    .replace(/^[.\s_]+|[.\s_]+$/g, '')
    .trim()
  return cleaned || I18N.anki.uncategorized
}

export { sanitizeFilename }

async function copyText(text, sourceEl) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text)
    } else {
      if (sourceEl) {
        sourceEl.select()
        document.execCommand('copy')
        window.getSelection?.removeAllRanges?.()
      }
    }
    return true
  } catch (err) {
    DBG('anki:copy:error', String(err))
    showToast(I18N.toast.anki.copyFailed)
    return false
  }
}

function buildActionButton(action, name, icon, label) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'btn btn--tonal anki-card__btn'
  btn.dataset.action = action
  btn.dataset.cat = name
  const iconEl = document.createElement('span')
  iconEl.className = 'material-symbols'
  iconEl.setAttribute('aria-hidden', 'true')
  iconEl.textContent = icon
  const labelEl = document.createElement('span')
  labelEl.textContent = label
  btn.append(iconEl, labelEl)
  return btn
}

function buildCard(section) {
  const card = document.createElement('article')
  const isAbnormal = isAbnormalCategory(section.name)
  if (isAbnormal) {
    card.className = 'anki-card anki-card--abnormal'
  } else {
    card.className = 'anki-card'
  }

  const header = document.createElement('header')
  header.className = 'anki-card__header'

  const tag = document.createElement('span')
  tag.className = 'anki-card__tag'
  tag.textContent = section.name
  header.append(tag)

  if (isAbnormal) {
    const title = document.createElement('div')
    title.className = 'anki-card__abnormal-title'
    title.textContent = I18N.anki.abnormalTitle
    header.append(title)
  }
  card.append(header)

  const area = document.createElement('textarea')
  area.className = 'anki-textarea anki-card__textarea'
  area.rows = 8
  area.spellcheck = false
  area.setAttribute('aria-label', t(I18N.anki.categoryTextareaLabel, { name: section.name }))
  area.dataset.cat = section.name
  area.value = section.text
  card.append(area)

  const toolbar = document.createElement('div')
  toolbar.className = 'anki-card__toolbar'
  toolbar.append(buildActionButton('copy', section.name, 'content_copy', I18N.anki.copyCategory))
  
  if (!isAbnormal) {
    toolbar.append(buildActionButton('export', section.name, 'download', I18N.anki.exportCategory))
    toolbar.append(buildActionButton('export-apkg', section.name, 'library_books', I18N.anki.exportCategoryApkg))
  }
  
  card.append(toolbar)
  return card
}

export function renderAnkiCards(rawText) {
  const container = $('anki-output-cards')
  if (!container) return 0
  container.replaceChildren()
  const sections = parseAnkiOutput(rawText)
  if (!sections.length) {
    const empty = document.createElement('p')
    empty.className = 'anki-cards__empty'
    empty.textContent = I18N.anki.cardsEmpty
    container.append(empty)
    return 0
  }
  for (const section of sections) {
    container.append(buildCard(section))
  }
  // 底部操作按钮封装为独立卡片
  const footer = buildFooterCard()
  if (footer) container.append(footer)
  DBG('anki:cards:render', { count: sections.length, names: sections.map((s) => s.name) })
  return sections.length
}

function buildFooterCard() {
  const footer = document.createElement('div')
  footer.className = 'anki-footer-card'
  footer.innerHTML = `
    <div class="anki-footer-card__actions">
      <button type="button" id="anki-copy" class="btn btn--tonal anki-footer-card__btn" data-anki-action="copy-all">
        <span class="material-symbols" aria-hidden="true">content_copy</span>
        <span data-i18n="anki.copyAll">${I18N.anki.copyAll}</span>
      </button>
      <button type="button" id="anki-download" class="btn btn--tonal anki-footer-card__btn" data-anki-action="download-all">
        <span class="material-symbols" aria-hidden="true">download</span>
        <span data-i18n="anki.exportAllTxt">${I18N.anki.exportAllTxt}</span>
      </button>
      <button type="button" id="anki-apkg" class="btn btn--filled anki-footer-card__btn" data-anki-action="download-apkg">
        <span class="material-symbols" aria-hidden="true">library_books</span>
        <span data-i18n="anki.exportApkg">${I18N.anki.exportApkg}</span>
      </button>
    </div>
  `
  return footer
}

function findCategoryArea(name) {
  const container = $('anki-output-cards')
  if (!container) return null
  for (const area of container.querySelectorAll('textarea[data-cat]')) {
    if (area.dataset.cat === name) return area
  }
  return null
}

function collectSections() {
  const container = $('anki-output-cards')
  if (!container) return []
  const out = []
  for (const area of container.querySelectorAll('textarea[data-cat]')) {
    const text = area.value.trim()
    if (!text) continue
    out.push({ name: area.dataset.cat || I18N.anki.uncategorized, text })
  }
  return out
}

async function copyCategory(name) {
  const area = findCategoryArea(name)
  const text = area ? area.value.trim() : ''
  if (!text) {
    showToast(I18N.toast.anki.outputEmptyCopy)
    return
  }
  if (await copyText(text, area)) {
    showToast(t(I18N.toast.anki.categoryCopied, { name }))
  }
}

function exportCategory(name) {
  const area = findCategoryArea(name)
  const text = area ? area.value.trim() : ''
  if (!text) {
    showToast(I18N.toast.anki.outputEmptyDownload)
    return
  }
  const tag = getSourceTagDisplayName()
  const filename = tag
    ? `${EXPORT_TXT_FILENAME_PREFIX}${sanitizeFilename(tag)}_${sanitizeFilename(name)}_${getTodayDateString()}.txt`
    : `${EXPORT_TXT_FILENAME_PREFIX}${sanitizeFilename(name)}_${getTodayDateString()}.txt`
  triggerDownload(filename, text, 'text/plain;charset=utf-8')
  DBG('anki:download:category', { filename, length: text.length })
  showToast(t(I18N.toast.anki.categoryDownloadStarted, { name }))
}

/**
 * 单分类 APKG 导出：仅把指定分类的内容打包，其余分类不写入。
 * 与全量导出共享同一份卡组/模型配置与校验逻辑，避免重复维护。
 * 生成中禁用传入的按钮防止重复触发，结束后恢复。
 */
async function exportCategoryApkg(name, btn) {
  const area = findCategoryArea(name)
  const text = area ? area.value.trim() : ''
  if (!text) {
    showToast(I18N.toast.anki.categoryApkgEmpty)
    return
  }
  const { tagId, tagConfig, hasTagConfig } = getCurrentExportConfig()
  if (!tagConfig?.deckName || !tagConfig?.modelName) {
    showToast(I18N.toast.anki.apkgConfigRequired)
    return
  }
  const fieldError = validateAnkiExportFieldNames(tagConfig.fieldNames)
  if (fieldError) {
    const msg = fieldError.reason === 'duplicate'
      ? t(I18N.toast.anki.apkgFieldNamesDuplicate, { name: fieldError.name })
      : I18N.toast.anki.apkgFieldNamesEmpty
    showToast(msg, { status: 'error' })
    return
  }
  notifyDefaultTagConfig(tagId, hasTagConfig)
  // 业务级互斥：全量/单分类共享同一把锁，已有导出进行时直接拒绝，避免并发建库与压缩。
  if (apkgGenerating) {
    showToast(I18N.toast.anki.apkgBusy, { status: 'info' })
    return
  }
  apkgGenerating = true
  const labelEl = btn?.children?.[1]
  const prevLabel = labelEl ? labelEl.textContent : ''
  if (btn) btn.disabled = true
  if (btn) btn.classList.add('is-busy')
  if (labelEl) labelEl.textContent = I18N.anki.apkgGenerating
  try {
    const sections = [{ name, text }]
    const { bytes, noteCount, cardCount } = await generateApkg(sections, tagConfig)
    const tag = getSourceTagDisplayName()
    const base = tag
      ? `${APKG_FILENAME_PREFIX}${sanitizeFilename(tag)}_${sanitizeFilename(name)}_${getTodayDateString()}`
      : `${APKG_FILENAME_PREFIX}${sanitizeFilename(name)}_${getTodayDateString()}`
    triggerDownload(`${base}.apkg`, bytes, 'application/apkg')
    DBG('anki:apkg:download-category', { deck: tagConfig.deckName, model: tagConfig.modelName, name, bytes: bytes.length, noteCount, cardCount })
    showToast(t(I18N.toast.anki.categoryApkgGenerated, { name, count: String(noteCount) }), { status: 'success' })
  } catch (err) {
    const code = err && err.code
    DBG('anki:apkg:category-error', { code, message: String(err && err.message || err) })
    showToast(resolveApkgErrorToast(code), { status: 'error' })
  } finally {
    apkgGenerating = false
    if (btn) btn.disabled = false
    if (btn) btn.classList.remove('is-busy')
    if (labelEl && prevLabel) labelEl.textContent = prevLabel
  }
}

export async function copyAllAnkiOutput() {
  const sections = collectSections()
  if (!sections.length) {
    showToast(I18N.toast.anki.outputEmptyCopy)
    return
  }
  if (await copyText(composeAnkiOutput(sections))) {
    showToast(I18N.toast.anki.copied)
  }
}

export function downloadAllAnkiTxt() {
  const sections = collectSections().filter((s) => !isAbnormalCategory(s.name))
  if (!sections.length) {
    showToast(I18N.toast.anki.outputEmptyDownload)
    return
  }
  const text = sections.map((s) => s.text).join('\n')
  const tag = getSourceTagDisplayName()
  const filename = tag
    ? `${IMPORT_TXT_FILENAME_PREFIX}${sanitizeFilename(tag)}_${getTodayDateString()}.txt`
    : `${IMPORT_TXT_FILENAME_PREFIX}${getTodayDateString()}.txt`
  triggerDownload(filename, text, 'text/plain;charset=utf-8')
  DBG('anki:download:all', { filename, length: text.length, sections: sections.length })
  showToast(I18N.toast.anki.downloadStarted)
}

/**
 * APKG 全量导出：使用本次导出来源（当前生词标签）对应的卡组/模型配置生成 .apkg。
 *  1. 先过滤异常词汇分类，与 TXT 导出保持一致；空内容直接提示，不加载 sql.js。
 *  2. 未单独配置的标签回落到默认配置（defaultConfig），并提示"将使用默认卡组"，
 *     而不是中止导出——默认配置始终存在，保证用户导出路径不会被配置缺失卡死。
 *  3. 生成中禁用按钮并把文案切换为"正在生成…"，避免重复点击与并发。
 *  4. 引擎加载失败（WASM 拉取失败）与普通生成失败区分提示，便于用户排查。
 */
export async function downloadAllAnkiApkg() {
  const sections = collectSections().filter((s) => !isAbnormalCategory(s.name))
  if (!sections.length) {
    showToast(I18N.toast.anki.apkgEmpty)
    return
  }
  const { tagId, tagConfig, hasTagConfig } = getCurrentExportConfig()
  if (!tagConfig?.deckName || !tagConfig?.modelName) {
    showToast(I18N.toast.anki.apkgConfigRequired)
    return
  }
  const fieldError = validateAnkiExportFieldNames(tagConfig.fieldNames)
  if (fieldError) {
    DBG('anki:apkg:invalid-fieldnames', { reason: fieldError.reason, name: fieldError.name })
    const msg = fieldError.reason === 'duplicate'
      ? t(I18N.toast.anki.apkgFieldNamesDuplicate, { name: fieldError.name })
      : I18N.toast.anki.apkgFieldNamesEmpty
    showToast(msg, { status: 'error' })
    return
  }

  notifyDefaultTagConfig(tagId, hasTagConfig)
  // 业务级互斥：与单分类导出共享同一把锁，已有导出进行时直接拒绝。
  if (apkgGenerating) {
    showToast(I18N.toast.anki.apkgBusy, { status: 'info' })
    return
  }
  apkgGenerating = true
  const apkgBtn = $('anki-apkg')
  const apkgLabel = apkgBtn?.querySelector('[data-i18n="anki.exportApkg"]')
  const prevLabel = apkgLabel?.textContent
  if (apkgBtn) apkgBtn.disabled = true
  if (apkgBtn) apkgBtn.classList.add('is-busy')
  if (apkgLabel) apkgLabel.textContent = I18N.anki.apkgGenerating
  try {
    const { bytes, noteCount, cardCount } = await generateApkg(sections, tagConfig)
    const tag = getSourceTagDisplayName()
    const base = tag
      ? `${APKG_FILENAME_PREFIX}${sanitizeFilename(tag)}_${getTodayDateString()}`
      : `${APKG_FILENAME_PREFIX}${getTodayDateString()}`
    triggerDownload(`${base}.apkg`, bytes, 'application/apkg')
    DBG('anki:apkg:download', { deck: tagConfig.deckName, model: tagConfig.modelName, bytes: bytes.length, noteCount, cardCount })
    // 使用真实导出条数（而非分类数），让用户核对实际写入 Anki 的笔记量。
    showToast(t(I18N.toast.anki.apkgGenerated, { count: String(noteCount) }), { status: 'success' })
  } catch (err) {
    const code = err && err.code
    DBG('anki:apkg:error', { code, message: String(err && err.message || err) })
    showToast(resolveApkgErrorToast(code), { status: 'error' })
  } finally {
    apkgGenerating = false
    if (apkgBtn) apkgBtn.disabled = false
    if (apkgBtn) apkgBtn.classList.remove('is-busy')
    if (apkgLabel && prevLabel) apkgLabel.textContent = prevLabel
  }
}

const guardOutput = createGuard('ankiOutputEventsBound')

export function bindAnkiOutputEvents() {
  // 幂等守卫：本委托监听挂在持久化的 #anki-output-cards 上，重复调用不得二次绑定。
  if (guardOutput.is()) return
  const container = $('anki-output-cards')
  if (!container) return
  guardOutput.set()
  // 输入区"来源 + 配置"状态条：首次渲染 + 订阅导出配置变更即时刷新（幂等）。
  subscribeAnkiSourceStatus()
  refreshAnkiSourceStatus()
  container.addEventListener('click', (event) => {
    // 分类级按钮
    const btn = event.target?.closest?.('button[data-action]')
    if (btn && !btn.disabled && container.contains(btn)) {
      const name = btn.dataset.cat || ''
      if (btn.dataset.action === 'copy') {
        copyCategory(name)
      } else if (btn.dataset.action === 'export') {
        exportCategory(name)
      } else if (btn.dataset.action === 'export-apkg') {
        exportCategoryApkg(name, btn)
      }
      return
    }
    // 底部全局按钮
    const footerBtn = event.target?.closest?.('button[data-anki-action]')
    if (footerBtn && !footerBtn.disabled && container.contains(footerBtn)) {
      if (footerBtn.dataset.ankiAction === 'copy-all') {
        copyAllAnkiOutput()
      } else if (footerBtn.dataset.ankiAction === 'download-all') {
        downloadAllAnkiTxt()
      } else if (footerBtn.dataset.ankiAction === 'download-apkg') {
        downloadAllAnkiApkg()
      }
    }
  })
}

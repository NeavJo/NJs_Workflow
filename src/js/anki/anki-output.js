import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N, t } from '../locales.js'
import { getTodayDateString } from '../core/date.js'
import { triggerDownload } from '../backup/snapshot.js'
import { $ } from '../utils/dom-utils.js'
import { createGuard } from '../utils/guard.js'
import { getSelectedMemoTag, getMemoTags } from '../memo/memo-store.js'

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
// "异常词汇"是提示词约定的固定分类名，仅精确匹配，避免误伤含"异常"字样的用户自定义分类。
const ABNORMAL_CATEGORY_NAME = '异常词汇'

/**
 * 判断某分类是否为约定中的"异常词汇"分类（精确匹配，非包含匹配）。
 */
function isAbnormalCategory(name) {
  return String(name || '') === ABNORMAL_CATEGORY_NAME
}

/**
 * 获取当前选中的笔记标签显示名（去 # 前缀）。
 * 未配置或无法匹配时返回空字符串，由调用方做兜底。
 */
function getSelectedTagDisplayName() {
  const tagId = String(getSelectedMemoTag() || '')
  if (!tagId) return ''
  const tags = getMemoTags()
  const found = tags.find((t) => t.id === tagId)
  return found?.name ? found.name.replace(/^#/, '') : tagId.replace(/^#/, '')
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
      <button type="button" id="anki-download" class="btn btn--filled anki-footer-card__btn" data-anki-action="download-all">
        <span class="material-symbols" aria-hidden="true">download</span>
        <span data-i18n="anki.exportAllTxt">${I18N.anki.exportAllTxt}</span>
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
  const tag = getSelectedTagDisplayName()
  const filename = tag
    ? `${EXPORT_TXT_FILENAME_PREFIX}${sanitizeFilename(tag)}_${sanitizeFilename(name)}_${getTodayDateString()}.txt`
    : `${EXPORT_TXT_FILENAME_PREFIX}${sanitizeFilename(name)}_${getTodayDateString()}.txt`
  triggerDownload(filename, text, 'text/plain;charset=utf-8')
  DBG('anki:download:category', { filename, length: text.length })
  showToast(t(I18N.toast.anki.categoryDownloadStarted, { name }))
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
  const tag = getSelectedTagDisplayName()
  const filename = tag
    ? `${IMPORT_TXT_FILENAME_PREFIX}${sanitizeFilename(tag)}_${getTodayDateString()}.txt`
    : `${IMPORT_TXT_FILENAME_PREFIX}${getTodayDateString()}.txt`
  triggerDownload(filename, text, 'text/plain;charset=utf-8')
  DBG('anki:download:all', { filename, length: text.length, sections: sections.length })
  showToast(I18N.toast.anki.downloadStarted)
}

const guardOutput = createGuard('ankiOutputEventsBound')

export function bindAnkiOutputEvents() {
  // 幂等守卫：本委托监听挂在持久化的 #anki-output-cards 上，重复调用不得二次绑定。
  if (guardOutput.is()) return
  const container = $('anki-output-cards')
  if (!container) return
  guardOutput.set()
  container.addEventListener('click', (event) => {
    // 分类级按钮
    const btn = event.target?.closest?.('button[data-action]')
    if (btn && !btn.disabled && container.contains(btn)) {
      const name = btn.dataset.cat || ''
      if (btn.dataset.action === 'copy') {
        copyCategory(name)
      } else if (btn.dataset.action === 'export') {
        exportCategory(name)
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
      }
    }
  })
}

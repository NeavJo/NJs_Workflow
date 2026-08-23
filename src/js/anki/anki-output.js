import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N, t } from '../locales.js'
import { getTodayDateString } from '../core/date.js'
import { triggerDownload } from '../backup/snapshot.js'
import { $ } from '../utils/dom-utils.js'

/**
 * Anki 输出区：AI 返回结果解析与分类卡片渲染
 *  - parseAnkiOutput：按 `=== [分类名] ===` 行标记切割纯文本为有序分类数组。
 *  - composeAnkiOutput：反向拼接，保证 parse → compose 往返一致（全局复制 / 导出用）。
 *  - renderAnkiCards：按解析结果动态生成分类卡片（标签 + 可编辑 textarea + 快捷按钮组）。
 *  - 卡片级与全局复制 / 导出；卡片按钮走事件委托，DOM 为唯一数据源。
 */

const ANKI_TXT_FILENAME_PREFIX = 'Anki_Import_'

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

function sanitizeFilename(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
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
  const isAbnormal = section.name.includes('异常')
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
  DBG('anki:cards:render', { count: sections.length, names: sections.map((s) => s.name) })
  return sections.length
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
  const filename = `Anki_${sanitizeFilename(name)}_${getTodayDateString()}.txt`
  triggerDownload(filename, text)
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
  const sections = collectSections().filter((s) => !s.name.includes('异常'))
  if (!sections.length) {
    showToast(I18N.toast.anki.outputEmptyDownload)
    return
  }
  const text = sections.map((s) => s.text).join('\n')
  const filename = `${ANKI_TXT_FILENAME_PREFIX}${getTodayDateString()}.txt`
  triggerDownload(filename, text)
  DBG('anki:download:all', { filename, length: text.length, sections: sections.length })
  showToast(I18N.toast.anki.downloadStarted)
}

export function bindAnkiOutputEvents() {
  const container = $('anki-output-cards')
  const copyBtn = $('anki-copy')
  const dlBtn = $('anki-download')
  copyBtn?.addEventListener('click', copyAllAnkiOutput)
  dlBtn?.addEventListener('click', downloadAllAnkiTxt)
  container?.addEventListener('click', (event) => {
    const btn = event.target?.closest?.('button[data-action]')
    if (!btn || btn.disabled || !container.contains(btn)) return
    const name = btn.dataset.cat || ''
    if (btn.dataset.action === 'copy') {
      copyCategory(name)
    } else if (btn.dataset.action === 'export') {
      exportCategory(name)
    }
  })
}

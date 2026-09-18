import { DBG } from '../core/debug.js'
import { I18N, t as translate } from '../locales.js'
import { escapeHtml } from '../utils/dom-utils.js'
import { getMemos, getMemoTags, getSelectedMemoTag, onMemosChange, onMemoTagsChange } from './memo-store.js'

/**
 * 笔记渲染层：只读 store 产出 DOM；事件绑定交给 memo-events.js。
 */

function countWords(content) {
  if (!content) return 0
  return content.split('\n').filter((line) => {
    const t = line.trim()
    if (!t) return false
    return !/^.+?[：:]\s*$/.test(t)
  }).length
}

function createMemoCard(memo, memoTags) {
  const card = document.createElement('article')
  card.className = 'memo-card'
  card.dataset.id = String(memo.id)
  const lineCount = countWords(memo.content)
  const isLong = lineCount > 7
  card.classList.toggle("memo-card--long", isLong)
  const tagOptions = memoTags
    .map((t) => `<option value="${escapeHtml(t.id)}" ${t.id === memo.tag ? 'selected' : ''}>${escapeHtml(t.name)}</option>`)
    .join('')

  card.innerHTML = `
    <div class="memo-card__header">
      <div class="memo-card__meta">
        <time class="memo-card__time" datetime=""></time>
        <span class="memo-tag-chip memo-tag-chip--display"></span>
        <span class="chip chip--outline" style="margin-left:4px;">${translate(I18N.memo.wordCount, { count: lineCount })}</span>
        <select class="memo-tag-select" hidden aria-label="${escapeHtml(I18N.common.selectTagAria)}">${tagOptions}</select>
      </div>
      <div class="memo-card__actions">
        <button class="memo-card__edit" type="button" data-memo-action="edit" aria-label="${I18N.memo.editAria}">
          <span class="material-symbols" aria-hidden="true">edit</span>
        </button>
        <button class="memo-card__save" type="button" data-memo-action="save" aria-label="${I18N.memo.saveAria}" hidden>
          <span class="material-symbols" aria-hidden="true">check</span>
        </button>
        <button class="memo-card__cancel" type="button" data-memo-action="cancel" aria-label="${I18N.memo.cancelAria}" hidden>
          <span class="material-symbols" aria-hidden="true">close</span>
        </button>
        <button class="memo-card__delete" type="button" data-memo-action="delete" aria-label="${I18N.memo.deleteAria}">
          <span class="material-symbols" aria-hidden="true">delete</span>
        </button>
      </div>
    </div>
    <div class="memo-card__body">
      <pre class="memo-card__content${isLong ? ' memo-card__content--collapsed' : ''}"></pre>
      <textarea class="memo-card__editor" rows="5" hidden></textarea>
      <button class="memo-card__copy" type="button" data-memo-action="copy" aria-label="${I18N.memo.copyAria}">
        <span class="material-symbols" aria-hidden="true">content_copy</span>
        <span class="memo-card__copy__label">${I18N.memo.copyBtn}</span>
      </button>
      <button class="memo-card__anki" type="button" data-memo-action="anki" aria-label="复制到Anki处理机">
        <span class="material-symbols" aria-hidden="true">psychology</span>
        <span class="memo-card__anki__label">${I18N.anki.processInAnki}</span>
      </button>
    </div>
    ${isLong ? `<div class="memo-card__footer">
      <button class="memo-card__expand" type="button" data-memo-action="expand" aria-label="${I18N.memo.expandAria}" aria-expanded="false">
        <span class="memo-card__expand__label">${I18N.memo.expandBtn}</span>
        <span class="material-symbols memo-card__expand__icon" aria-hidden="true">expand_more</span>
      </button>
    </div>` : ''}
  `;

  const timeEl = card.querySelector('.memo-card__time')
  const memoDate = new Date(memo.id)
  timeEl.dateTime = Number.isNaN(memoDate.getTime()) ? '' : memoDate.toISOString()
  timeEl.textContent = memo.timestamp

  const tagChip = card.querySelector('.memo-tag-chip--display')
  const tagInfo = memoTags.find((t) => t.id === memo.tag)
  tagChip.textContent = tagInfo ? tagInfo.name : String(memo.tag ?? '').replace(/^#/, '')

  const contentEl = card.querySelector('.memo-card__content')
  contentEl.textContent = memo.content

  return card
}

export function renderMemos() {
  const stream = document.querySelector('#memo-stream')
  if (!stream) return
  const memos = getMemos()
  const tags = getMemoTags()
  const sorted = [...memos].sort((a, b) => b.id - a.id)
  stream.replaceChildren(...sorted.map((memo) => createMemoCard(memo, tags)))
  const empty = document.querySelector('#memo-empty')
  if (empty) empty.hidden = sorted.length > 0
  updateMemoCounters()
}

export function updateMemoCounters() {
  const total = getMemos().length
  const counter = document.querySelector('#memo-counter')
  if (counter) counter.textContent = translate(I18N.memo.recordsCount, { count: total })
}

export function renderTagSelector() {
  const container = document.querySelector('.tag-selector')
  if (!container) return
  const memoTags = getMemoTags()
  const selectedId = getSelectedMemoTag()
  container.replaceChildren(
    ...memoTags.map((t) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'tag-btn' + (t.id === selectedId ? ' is-selected' : '')
      btn.dataset.value = t.id
      btn.innerHTML = `<span class="material-symbols" aria-hidden="true">${escapeHtml(t.icon)}</span><span></span>`
      btn.querySelector('span:last-child').textContent = t.name
      btn.dataset.action = 'select-tag'
      return btn
    })
  )
}

/**
 * 移动端标签触发器：把"当前选中标签"压缩成单点 chip 按钮，
 * 点击后由 memo-events 打开底部弹窗。
 */
export function renderMemoTagPickerTrigger() {
  const labelEl = document.getElementById('memo-tag-picker-trigger-label')
  const iconEl = document.getElementById('memo-tag-picker-trigger-icon')
  if (!labelEl && !iconEl) return
  const tags = getMemoTags()
  const selectedId = getSelectedMemoTag()
  const tag = tags.find((t) => t.id === selectedId) || tags[0]
  if (!tag) return
  if (labelEl) labelEl.textContent = tag.name
  if (iconEl) iconEl.textContent = tag.icon || 'label'
}

/**
 * 移动端标签选择弹窗：把可用标签渲染成大按钮列表。
 */
export function renderMemoTagPickerList() {
  const list = document.getElementById('memo-tag-picker-list')
  if (!list) return
  const tags = getMemoTags()
  const selectedId = getSelectedMemoTag()
  const fragment = document.createDocumentFragment()
  tags.forEach((tag) => {
    const li = document.createElement('li')
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'memo-tag-picker__item' + (tag.id === selectedId ? ' is-selected' : '')
    btn.dataset.value = tag.id
    btn.dataset.action = 'select-memo-tag-from-sheet'

    const icon = document.createElement('span')
    icon.className = 'material-symbols'
    icon.setAttribute('aria-hidden', 'true')
    icon.textContent = tag.icon || 'label'

    const labelWrap = document.createElement('span')
    labelWrap.className = 'memo-tag-picker__item__label'
    const name = document.createElement('span')
    name.className = 'memo-tag-picker__item__name'
    name.textContent = tag.name
    const sub = document.createElement('span')
    sub.className = 'memo-tag-picker__item__id'
    sub.textContent = tag.id
    labelWrap.append(name, sub)

    const check = document.createElement('span')
    check.className = 'memo-tag-picker__item__check'
    check.setAttribute('aria-hidden', 'true')
    const checkIcon = document.createElement('span')
    checkIcon.className = 'material-symbols'
    checkIcon.textContent = 'check'
    check.append(checkIcon)

    btn.append(icon, labelWrap, check)
    li.append(btn)
    fragment.appendChild(li)
  })
  list.replaceChildren(fragment)
}

/**
 * 订阅笔记增删改：任意 addMemo / appendOrDailyMemo / deleteMemo / updateMemo* 都会
 * 自动重新渲染 #memo-stream，使 UI 与 store 实时同步（无需手动刷新）。
 */
let memosUnsubscribe = null
export function subscribeMemoChanges() {
  if (memosUnsubscribe) return memosUnsubscribe
  memosUnsubscribe = onMemosChange((nextMemos) => {
    DBG('memo:change', { length: nextMemos.length })
    renderMemos()
  })
  return memosUnsubscribe
}

/**
 * 订阅标签变更：任意 addMemoTag / deleteMemoTag / renameMemoTag / setSelectedMemoTag
 * 都会同时刷新 .tag-selector 桌面 tab、.tag-picker-trigger 移动 trigger，
 * 以及弹窗中的列表（弹窗打开时）。
 */
let memoTagsUnsubscribe = null
export function subscribeMemoTagChanges() {
  if (memoTagsUnsubscribe) return memoTagsUnsubscribe
  memoTagsUnsubscribe = onMemoTagsChange(({ tags, selectedId }) => {
    DBG('memo:tags-change', { count: tags.length, selectedId })
    renderTagSelector()
    renderMemoTagPickerTrigger()
    renderMemoTagPickerList()
  })
  return memoTagsUnsubscribe
}

/**
 * german-renderer.js — 渲染层：候选词 / 骨架屏 / 详情卡 / 状态行
 * -----------------------------------------------------------------------------
 * 约束：
 *   - 只读 store 快照，不调 store 方法，不绑事件
 *   - 使用 escapeHtml 防注入
 *   - 使用 replaceChildren 原子替换，避免 DOM 残留
 *   - DOM 元素不存在时安全返回
 */

import { escapeHtml } from '../utils/dom-utils.js'
import { I18N } from '../locales.js'
import { DBG } from '../core/debug.js'

/** 视图根选择器 */
function root() {
  return document.querySelector('.view--german')
}

function getSuggestionsEl() {
  return document.getElementById('german-suggestions')
}

function getStatusEl() {
  return document.getElementById('german-result-status')
}

function getStatusTextEl() {
  return document.getElementById('german-status-text')
}

function getRetryBtn() {
  return document.getElementById('german-retry')
}

function getDetailRoot() {
  return document.getElementById('german-detail')
}

/**
 * 渲染候选词下拉（本地即时匹配，0 延迟）。
 * @param {Array} suggestions — searchLocalDictionary 返回的候选列表
 */
export function renderSuggestions(suggestions) {
  const el = getSuggestionsEl()
  if (!el) return
  if (!suggestions || suggestions.length === 0) {
    el.hidden = true
    el.replaceChildren()
    return
  }
  const frag = document.createDocumentFragment()
  for (const s of suggestions) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'german-suggestion'
    btn.dataset.word = s.word
    btn.innerHTML =
      `<span class="german-suggestion__word">${escapeHtml(s.word)}</span>` +
      `<span class="german-suggestion__pos">${escapeHtml(s.posLabel || s.pos)}</span>` +
      `<span class="german-suggestion__zh">${escapeHtml(s.zh)}</span>`
    frag.appendChild(btn)
  }
  el.replaceChildren(frag)
  el.hidden = false
}

/**
 * 渲染状态行。
 * @param {'loading'|'error'|'empty'|null} kind
 * @param {string} message
 */
export function renderStatus(kind, message) {
  const el = getStatusEl()
  const textEl = getStatusTextEl()
  const retryBtn = getRetryBtn()
  if (!el || !textEl) return
  if (!kind) {
    el.hidden = true
    if (retryBtn) retryBtn.hidden = true
    return
  }
  textEl.textContent = message || ''
  el.hidden = false
  if (retryBtn) retryBtn.hidden = kind !== 'error'
}

/**
 * 渲染骨架屏（LLM 调用等待期间）。
 */
export function renderSkeleton() {
  const el = getDetailRoot()
  if (!el) return
  el.hidden = false
  el.innerHTML =
    '<div class="german-detail-card german-skeleton">' +
      '<div class="german-skeleton__word-row">' +
        '<div class="german-skeleton__bar german-skeleton__bar--word"></div>' +
        '<div class="german-skeleton__circle"></div>' +
      '</div>' +
      '<div class="german-skeleton__bar german-skeleton__bar--phonetic"></div>' +
      '<div class="german-skeleton__dict">' +
        '<div class="german-skeleton__bar german-skeleton__bar--title"></div>' +
        '<div class="german-skeleton__bar german-skeleton__bar--line"></div>' +
        '<div class="german-skeleton__bar german-skeleton__bar--line"></div>' +
        '<div class="german-skeleton__bar german-skeleton__bar--line german-skeleton__bar--short"></div>' +
      '</div>' +
    '</div>'
}

/**
 * 渲染完整详情卡（LLM 返回数据后）。
 * @param {object} detail — { word, ipa, grammar, definitions, source }
 */
export function renderDetail(detail) {
  const el = getDetailRoot()
  if (!el) return
  if (!detail) {
    el.replaceChildren()
    el.hidden = true
    return
  }

  const g = I18N.german || {}
  const word = escapeHtml(detail.word || '')
  const ipa = escapeHtml(detail.ipa || '')
  const grammar = escapeHtml(detail.grammar || '')
  const definitions = Array.isArray(detail.definitions) ? detail.definitions : []
  const source = escapeHtml(detail.source || 'AI')

  // 音标行
  const phoneticHtml = ipa
    ? `<p class="german-detail-card__phonetic">${ipa}</p>`
    : `<p class="german-detail-card__phonetic german-detail-card__phonetic--empty">${escapeHtml(g.missingData || '暂无')}</p>`

  // 释义列表
  let defsHtml = ''
  if (definitions.length === 0) {
    defsHtml = `<p class="german-missing">${escapeHtml(g.missingData || '暂无数据')}</p>`
  } else {
    defsHtml = '<ol class="german-definitions">'
    for (const d of definitions) {
      const meaning = escapeHtml(d.meaning || '')
      const tag = escapeHtml(d.tag || '')
      const exDe = escapeHtml(d.example_de || '')
      const exCn = escapeHtml(d.example_cn || '')
      const examplesHtml = (exDe || exCn)
        ? `<ul class="german-examples"><li class="german-example"><i>${exDe}</i><span>(${exCn})</span></li></ul>`
        : ''
      defsHtml +=
        `<li class="german-definition">` +
          (tag ? `<div class="german-definition__trans">${tag}</div>` : '') +
          `<div class="german-definition__main">${meaning}</div>` +
          examplesHtml +
        `</li>`
    }
    defsHtml += '</ol>'
  }

  // 语法信息
  const grammarHtml = grammar
    ? `<div class="german-inflection">${grammar}</div>`
    : ''

  el.hidden = false
  el.innerHTML =
    '<div class="german-detail-card">' +
      `<div class="german-detail-card__header">` +
        `<div class="german-detail-card__word-row">` +
          `<span class="german-detail-card__word">${word}</span>` +
          `<button class="german-speak btn btn--icon" type="button" aria-label="${escapeHtml(g.speakAria || '朗读')}" title="${escapeHtml(g.speakAria || '朗读')}">` +
            `<span class="material-symbols" aria-hidden="true">volume_up</span>` +
          `</button>` +
        `</div>` +
        phoneticHtml +
      `</div>` +
      `<div class="german-detail-card__actions">` +
        `<button class="german-add-memo btn btn--tonal" type="button">` +
          `<span class="material-symbols" aria-hidden="true">add_circle</span>` +
          `<span>${escapeHtml(g.addMemo || '添加到生词本')}</span>` +
        `</button>` +
      `</div>` +
      `<details class="german-dict" open>` +
        `<summary class="german-dict__summary">${escapeHtml(g.resultsTitle || '词典结果')}</summary>` +
        `<div class="german-dict__body">` +
          (grammarHtml ? `<div class="german-entry__meta">${grammarHtml}</div>` : '') +
          defsHtml +
        `</div>` +
      `</details>` +
      `<div class="german-detail-card__source">` +
        `<span class="german-detail-card__source-label">${escapeHtml(g.sourceLabel || '数据源')}: ${source}</span>` +
      `</div>` +
    '</div>'

  DBG('german:render:detail', { word: detail.word, defs: definitions.length })
}

/**
 * 主渲染入口：根据 store 快照决定渲染什么。
 * 由 onGermanStateChange 订阅回调调用。
 */
export function renderGermanAssistant(state) {
  if (!root()) return

  // 候选词（本地即时）
  renderSuggestions(state.suggestions || [])

  // 详情区域
  if (state.detailLoading) {
    // LLM 加载中 → 骨架屏
    renderStatus(null)
    renderSkeleton()
  } else if (state.detailError) {
    // 加载失败 → 状态行 + 重试
    renderStatus('error', state.detailError)
    const detail = getDetailRoot()
    if (detail) { detail.replaceChildren(); detail.hidden = true }
  } else if (state.detail) {
    // 正常结果
    renderStatus(null)
    renderDetail(state.detail)
  } else {
    // 初始态
    renderStatus(null)
    const detail = getDetailRoot()
    if (detail) { detail.replaceChildren(); detail.hidden = true }
  }
}

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
import { getAnkiSettings } from '../anki/anki-store.js'

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
 * 创建带 class + 文本的 <span> 或 <p> 节点。
 * @param {string} tag 元素标签
 * @param {string} className 类名（空格分隔）
 * @param {string} text 文本内容（已在外层 escapeHtml 过，textContent 无需再转义）
 */
function textEl(tag, className, text) {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined && text !== '') el.textContent = text
  return el
}

/** 创建材质图标 span（.material-symbols，含 aria-hidden）。 */
function iconEl(symbol) {
  const el = document.createElement('span')
  el.className = 'material-symbols'
  el.setAttribute('aria-hidden', 'true')
  el.textContent = symbol
  return el
}

/**
 * 把原始德语例句按 {…} 和 <…> 拆词渲染。
 * 两种标记的内容最终都通过 textContent 写入，避免把标记解析和 HTML 转义混在一起。
 */
function renderExampleWithTerms(el, rawText, allowedPrepositions = []) {
  const text = String(rawText || '')
  const allowed = new Set(allowedPrepositions.map((value) => String(value).toLocaleLowerCase()))
  const parts = text.split(/(\{[^{}]+\}|<[^<>]+>)/g)
  for (const part of parts) {
    if (!part) continue
    const termMatch = part.match(/^\{(.+)\}$/)
    const prepMatch = part.match(/^\<(.+)\>$/)
    if (termMatch) {
      const m = document.createElement('mark')
      m.className = 'german-example__term'
      m.textContent = termMatch[1]
      el.appendChild(m)
    } else if (prepMatch && allowed.has(prepMatch[1].toLocaleLowerCase())) {
      const m = document.createElement('mark')
      m.className = 'german-example__preposition'
      m.textContent = prepMatch[1]
      el.appendChild(m)
    } else {
      el.appendChild(document.createTextNode(part))
    }
  }
}

/**
 * 渲染完整详情卡（LLM 返回数据后）。
 * 用 createElement + replaceChildren 构建（与候选词渲染一致），避免 innerHTML 解析开销；
 * 普通文本直接写入 textContent，例句标记拆分后各片段也只写入文本节点。
 * 保留全部 class 与 DOM 结构不变。
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
  const word = String(detail.word || '')
  const ipa = String(detail.ipa || '')
  const grammar = String(detail.grammar || '')
  // 数据源展示：优先显示 Anki 处理机设置里配置的 LLM 模型名（用户可见其实际由哪个模型生成），
  // 未配置模型时回退到 detail.source 对应的原始标签（godic 代理 / Free Dictionary 等）。
  const configuredModel = (getAnkiSettings().modelId || '').trim()
  const sourceFallback = String(g.sourceLabels?.[detail.source] || detail.source || 'AI')
  const source = configuredModel || sourceFallback
  const speakAria = String(g.speakAria || '朗读')
  const refetchAria = String(g.refetchAria || '重新获取')
  const definitions = Array.isArray(detail.definitions) ? detail.definitions : []

  // 卡片根
  const card = document.createElement('div')
  card.className = 'german-detail-card'

  // 头部：单词行 + 音标行
  const header = document.createElement('div')
  header.className = 'german-detail-card__header'

  const wordRow = document.createElement('div')
  wordRow.className = 'german-detail-card__word-row'
  wordRow.appendChild(textEl('span', 'german-detail-card__word', word))

  const speakBtn = document.createElement('button')
  speakBtn.type = 'button'
  speakBtn.className = 'german-speak btn btn--icon'
  speakBtn.setAttribute('aria-label', speakAria)
  speakBtn.setAttribute('title', speakAria)
  speakBtn.appendChild(iconEl('volume_up'))

  const refetchBtn = document.createElement('button')
  refetchBtn.type = 'button'
  refetchBtn.className = 'german-refetch btn btn--icon'
  refetchBtn.setAttribute('aria-label', refetchAria)
  refetchBtn.setAttribute('title', refetchAria)
  refetchBtn.appendChild(iconEl('refresh'))

  wordRow.appendChild(speakBtn)
  wordRow.appendChild(refetchBtn)

  // 音标行（无音标时显示"暂无"）
  const phonetic = ipa
    ? textEl('p', 'german-detail-card__phonetic', ipa)
    : textEl('p', 'german-detail-card__phonetic german-detail-card__phonetic--empty', String(g.missingData || '暂无'))

  header.appendChild(wordRow)
  header.appendChild(phonetic)

  // 操作区：加生词本
  const actions = document.createElement('div')
  actions.className = 'german-detail-card__actions'
  const addBtn = document.createElement('button')
  addBtn.type = 'button'
  addBtn.className = 'german-add-memo btn btn--tonal'
  addBtn.appendChild(iconEl('add_circle'))
  addBtn.appendChild(textEl('span', '', String(g.addMemo || '添加到生词本')))
  actions.appendChild(addBtn)

  // 词典结果（<details open>）：语法 + 释义列表
  const dict = document.createElement('details')
  dict.className = 'german-dict'
  dict.open = true
  dict.appendChild(textEl('summary', 'german-dict__summary', String(g.resultsTitle || '词典结果')))

  const dictBody = document.createElement('div')
  dictBody.className = 'german-dict__body'

  if (grammar) {
    const meta = document.createElement('div')
    meta.className = 'german-entry__meta'
    const inf = document.createElement('div')
    inf.className = 'german-inflection'
    inf.textContent = grammar
    meta.appendChild(inf)
    dictBody.appendChild(meta)
  }

  if (definitions.length === 0) {
    dictBody.appendChild(textEl('p', 'german-missing', String(g.missingData || '暂无数据')))
  } else {
    const ol = document.createElement('ol')
    ol.className = 'german-definitions'
    for (const d of definitions) {
      const meaning = String(d.meaning || '')
      const tag = String(d.tag || '')
      const exDe = String(d.example_de || '')
      const exCn = String(d.example_cn || '')
      const collocations = Array.isArray(d.collocations) ? d.collocations : []
      const exampleCollocation = collocations[d.example_collocation_index] || collocations[0]
      const examplePrepositions = exampleCollocation?.prepositions || []

      const li = document.createElement('li')
      li.className = 'german-definition'
      const meta = document.createElement('div')
      meta.className = 'german-definition__meta'
      if (tag) meta.appendChild(textEl('span', 'german-definition__trans', tag))
      if (d.collocations && d.collocations.length > 0) {
        const wrap = document.createElement('span')
        wrap.className = 'german-collocations'
        const label = document.createElement('span')
        label.className = 'german-collocations__label'
        label.textContent = g.collocationsLabel || '搭配：'
        wrap.appendChild(label)
        for (const col of d.collocations) {
          const badge = document.createElement('span')
          badge.className = 'german-collocations__item'
          badge.textContent = String(col.template || '')
          wrap.appendChild(badge)
        }
        meta.appendChild(wrap)
      }
      if (meta.childNodes.length > 0) li.appendChild(meta)
      li.appendChild(textEl('div', 'german-definition__main', meaning))

      if (exDe || exCn) {
        const ul = document.createElement('ul')
        ul.className = 'german-examples'
        const exLi = document.createElement('li')
        exLi.className = 'german-example'
        const em = document.createElement('i')
        renderExampleWithTerms(em, exDe, examplePrepositions)
        exLi.appendChild(em)
        exLi.appendChild(textEl('span', '', '(' + exCn + ')'))
        ul.appendChild(exLi)
        li.appendChild(ul)
      }
      ol.appendChild(li)
    }
    dictBody.appendChild(ol)
  }
  dict.appendChild(dictBody)

  // 数据源行
  const sourceRow = document.createElement('div')
  sourceRow.className = 'german-detail-card__source'
  sourceRow.appendChild(textEl('span', 'german-detail-card__source-label',
    String(g.sourceLabel || '数据源') + ': ' + source))

  card.appendChild(header)
  card.appendChild(actions)
  card.appendChild(dict)
  card.appendChild(sourceRow)

  el.hidden = false
  el.replaceChildren(card)

  DBG('german:render:detail', { word: detail.word, defs: definitions.length })
}

/**
 * 主渲染入口：根据 store 快照决定渲染什么。
 * 由 onGermanStateChange 订阅回调调用。
 *
 * 脏检查：渲染是幂等的（相同 state 产生相同 DOM），因此仅当
 * 关键字段（suggestions / detailLoading / detailError / detail）真正变化
 * 或子页不可见（需强制渲染）时才重渲染，避免每次 PubSub emit 都全量重渲染。
 */
let _lastRendered = null

/** 判断两次快照是否等效（关键渲染字段逐一比较）。 */
function isSameRenderSnapshot(prev, next) {
  if (!prev) return false
  if (prev.detailLoading !== next.detailLoading) return false
  if (prev.detailError !== next.detailError) return false
  // 详情对象：按引用比较（store 每次写都是新对象；未变时为同一引用）
  if (prev.detail !== next.detail) return false
  // 候选词：按长度 + 首尾项引用比较，避免每次全量 diff
  const ps = prev.suggestions || []
  const ns = next.suggestions || []
  if (ps.length !== ns.length) return false
  if (ps.length > 0) {
    if (ps[0].word !== ns[0].word) return false
    if (ps[ps.length - 1].word !== ns[ns.length - 1].word) return false
  }
  return true
}

export function renderGermanAssistant(state) {
  if (!root()) return
  // 子页不可见（如字号订阅回调在其它视图触发）时强制渲染，绕过脏检查
  const visible = document.querySelector('.view--german') !== null

  if (visible && isSameRenderSnapshot(_lastRendered, state)) return
  _lastRendered = state

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

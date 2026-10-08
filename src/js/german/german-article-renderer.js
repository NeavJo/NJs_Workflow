/**
 * german-article-renderer.js — 文章阅读模式渲染层
 * -----------------------------------------------------------------------------
 * 职责：只读文章 Store 快照，渲染：
 *   1. 输入 / 阅读两个子模式的切换（由 state.mode 驱动）；
 *   2. 阅读正文——按段落保真还原原文，文字词项渲染为可点击按钮；
 *   3. 逐段译文及其"翻译中 / 失败重试"状态，原文段与译文段交替排列。
 *
 * 约束（与 german-renderer.js 一致）：
 *   - 只读快照，不调 Store 方法，不绑事件；
 *   - 一律使用安全 DOM API（textContent / createTextNode），绝不把文章当 HTML 注入；
 *   - replaceChildren / Element.after 原子更新，元素不存在时安全返回。
 *
 * 保真核心（对应 spec「文章文本往返一致」）：
 *   store 解析出的每个段落带有 separator（其前导空白）与末段 trailing。
 *   渲染时把 separator 作为段落块的**首个文本节点**、把 trailing 作为正文容器
 *   的**末尾文本节点**写入，因此当不存在译文时，
 *   `#german-article-body` 的 textContent 与用户输入逐字符一致。
 *   词语按钮内只写入词本身，不掺杂图标或其它文本，避免破坏往返一致性。
 */

import { I18N, t } from '../locales.js'
import { DBG } from '../core/debug.js'

/** 正文容器选择器 */
function getBodyEl() {
  return document.getElementById('german-article-body')
}

function getArticleRoot() {
  return document.getElementById('german-article')
}

function getViewRoot() {
  return document.querySelector('.view--german')
}

function getModeSwitchItems() {
  return {
    dictionary: document.getElementById('german-mode-dictionary'),
    article: document.getElementById('german-mode-article')
  }
}

/**
 * 德语文字词项匹配正则。
 * 覆盖基础拉丁字母 + Latin-1 Supplement + Latin Extended-A/B（含 ä ö ü ß Ä Ö Ü）。
 * 连字符、撇号、数字、标点与空白均不属于词项——它们保留为普通文本节点，
 * 因此不会成为可点击按钮，符合「标点不可点击」的要求。
 */
const WORD_RE = /[A-Za-z\u00C0-\u024F]+/g

/** 读取文章文案节点（缺失时回退空对象，避免渲染期抛错）。 */
function articleCopy() {
  return (I18N.german && I18N.german.article) || {}
}

/* ====================================================================
 * 子模式切换（仅内存态视图，不涉及 Store）
 * ==================================================================== */

/** 文章视图是否处于展开状态（dictionary 子模式时为 false）。 */
let _viewOpen = false
// 译文显隐由渲染层持有：事件层切换显隐后，后续 PubSub 重建/替换译文节点
// 仍会沿用该状态，避免隐藏后的段落更新把译文重新显示出来。
let _translationsHidden = false

/**
 * 切换「查词 / 文章阅读」子模式。仅操作视图根节点的 class 与开关按钮的
 * aria 状态，不触碰 Store；具体的输入/阅读内容由 renderGermanArticle 渲染。
 * @param {boolean} open 是否进入文章阅读子模式
 */
export function setGermanArticleViewOpen(open) {
  const next = Boolean(open)
  _viewOpen = next
  const viewRoot = getViewRoot()
  if (viewRoot) viewRoot.classList.toggle('is-article-mode', next)
  const items = getModeSwitchItems()
  if (items.dictionary) {
    items.dictionary.classList.toggle('is-active', !next)
    items.dictionary.setAttribute('aria-selected', String(!next))
  }
  if (items.article) {
    items.article.classList.toggle('is-active', next)
    items.article.setAttribute('aria-selected', String(next))
  }
  DBG('german-article:view-open', { open: next })
}

/** 当前是否处于文章阅读子模式。 */
export function isGermanArticleViewOpen() {
  return _viewOpen
}

export function setGermanArticleTranslationsHidden(hidden) {
  _translationsHidden = Boolean(hidden)
  applyTranslationVisibility()
}

export function isGermanArticleTranslationsHidden() {
  return _translationsHidden
}

/**
 * 把当前译文显隐状态应用到全部译文节点。
 * 每次增量同步/全量重建后调用，避免新节点漏掉隐藏态。
 */
export function applyTranslationVisibility() {
  const body = getBodyEl()
  if (!body) return
  body.querySelectorAll('.german-article__translation').forEach((el) => {
    el.style.display = _translationsHidden ? 'none' : ''
  })
}

/* ====================================================================
 * 原文渲染（保真 + 安全）
 * ==================================================================== */

/**
 * 把一段纯文本按词项切分后写入容器：
 * 文字词项 → <button class="german-article__word">（纯文本按钮）；
 * 其余字符（空格 / 标点 / 数字 / 连字符 / 撇号）→ 原样文本节点。
 * 所有内容均经 textContent / createTextNode 写入，绝不解析为 HTML。
 */
function appendTokenizedText(el, text, paragraphIndex) {
  const source = String(text || '')
  const ariaTemplate = articleCopy().wordAria
  let last = 0
  WORD_RE.lastIndex = 0
  let match
  while ((match = WORD_RE.exec(source)) !== null) {
    if (match.index > last) {
      el.appendChild(document.createTextNode(source.slice(last, match.index)))
    }
    const word = match[0]
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'german-article__word'
    btn.textContent = word
    // 携带原始词形与段落索引，供事件层按原词形查询并做锚点管理
    btn.dataset.word = word
    btn.dataset.paragraphIndex = String(paragraphIndex)
    const label = ariaTemplate ? t(ariaTemplate, { word }) : word
    btn.setAttribute('aria-label', label)
    btn.setAttribute('title', label)
    el.appendChild(btn)
    last = match.index + word.length
  }
  if (last < source.length) {
    el.appendChild(document.createTextNode(source.slice(last)))
  }
}

/** 构建单个原文段落块（含其前导空白，保证往返一致）。 */
function buildParagraphEl(paragraph) {
  const pEl = document.createElement('div')
  pEl.className = 'german-article__paragraph'
  pEl.dataset.paragraphIndex = String(paragraph.index)
  // separator 作为段落块的首个文本节点：空行/缩进原样保留
  if (paragraph.separator) pEl.appendChild(document.createTextNode(paragraph.separator))
  appendTokenizedText(pEl, paragraph.text, paragraph.index)
  return pEl
}

/* ====================================================================
 * 逐段译文渲染（原文段 → 译文段 → 下一原文段）
 * ==================================================================== */

/**
 * 构建某段译文的展示块：
 *   done    → 译文文本；
 *   pending → 翻译中提示；
 *   error   → 错误提示 + 独立重试按钮（携带段落索引）。
 */
function buildTranslationEl(index, entry) {
  const wrap = document.createElement('div')
  wrap.className = 'german-article__translation'
  wrap.dataset.paragraphIndex = String(index)
  // 译文块首次创建时即继承当前显隐视图态，避免增量同步/重建后闪回默认显示
  if (_translationsHidden) wrap.style.display = 'none'
  const copy = articleCopy()

  if (entry.status === 'pending') {
    wrap.classList.add('is-pending')
    const row = document.createElement('div')
    row.className = 'german-article__translation-status'
    const spinner = document.createElement('span')
    spinner.className = 'german-article__spinner'
    spinner.setAttribute('aria-hidden', 'true')
    row.appendChild(spinner)
    const text = document.createElement('span')
    text.textContent = copy.translating || '正在翻译…'
    row.appendChild(text)
    wrap.appendChild(row)
    return wrap
  }

  if (entry.status === 'error') {
    wrap.classList.add('is-error')
    const row = document.createElement('div')
    row.className = 'german-article__translation-status'
    const msg = document.createElement('span')
    msg.className = 'german-article__translation-error'
    msg.textContent = entry.error || copy.translationFailed || '翻译失败'
    row.appendChild(msg)
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.className = 'german-article__translation-retry btn btn--tonal'
    retry.dataset.paragraphIndex = String(index)
    retry.textContent = copy.retryTranslation || '重试'
    row.appendChild(retry)
    wrap.appendChild(row)
    return wrap
  }

  // done：纯文本译文
  const body = document.createElement('p')
  body.className = 'german-article__translation-text'
  body.textContent = entry.text || ''
  wrap.appendChild(body)
  return wrap
}

/* ====================================================================
 * 主渲染
 * ==================================================================== */

/** 上次渲染快照，用于脏检查，避免每次 PubSub emit 全量重建（保留焦点/选区）。 */
let _last = { bodyEl: null, articleText: null, translations: null, mode: null }

/** 全量重建正文（仅在文章文本变化时执行）。 */
function rebuildBody(body, state) {
  body.replaceChildren()
  for (const paragraph of state.paragraphs) {
    body.appendChild(buildParagraphEl(paragraph))
  }
  // 末段 trailing：作为正文容器末尾文本节点，保证末尾空行也被还原
  const lastPara = state.paragraphs[state.paragraphs.length - 1]
  if (lastPara && lastPara.trailing) {
    body.appendChild(document.createTextNode(lastPara.trailing))
  }
}

/** 按 store 中的译文状态，增量同步每段译文块（不重建原文，保留焦点）。 */
function syncTranslations(body, state) {
  for (const paragraph of state.paragraphs) {
    const index = paragraph.index
    const entry = state.translations[index]
    const existing = body.querySelector(
      `.german-article__translation[data-paragraph-index="${index}"]`
    )
    if (!entry) {
      if (existing) existing.remove()
      continue
    }
    const next = buildTranslationEl(index, entry)
    if (existing) {
      // 就地替换内容，保持节点位置（原文段 → 译文段 → 下一原文段）
      existing.replaceWith(next)
    } else {
      const pEl = body.querySelector(`.german-article__paragraph[data-paragraph-index="${index}"]`)
      if (pEl) pEl.after(next)
    }
  }
}

/**
 * 渲染文章阅读子模式。
 * 由 onGermanArticleStateChange 订阅回调调用。
 * @param {object} state — getGermanArticleState() 快照
 */
export function renderGermanArticle(state) {
  if (!state) return
  const articleRoot = getArticleRoot()
  const body = getBodyEl()
  if (!articleRoot || !body) return

  // 子模式（input / reading）由 CSS 依据 data-article-mode 决定显隐
  articleRoot.dataset.articleMode = state.mode === 'reading' ? 'reading' : 'input'

  const articleChanged =
    _last.bodyEl !== body ||
    _last.articleText !== state.articleText ||
    _last.mode !== state.mode

  if (state.mode === 'reading' && state.hasArticle && state.paragraphs.length > 0) {
    if (articleChanged) {
      rebuildBody(body, state)
    }
    syncTranslations(body, state)
    // 重建/增量同步后重放隐藏态，避免新译文节点闪回默认显示
    applyTranslationVisibility()
  } else if (articleChanged) {
    body.replaceChildren()
  }

  _last = {
    bodyEl: body,
    articleText: state.articleText,
    translations: state.translations,
    mode: state.mode
  }
  DBG('german-article:render', {
    mode: state.mode,
    paragraphs: state.paragraphs.length,
    translations: Object.keys(state.translations || {}).length
  })
}

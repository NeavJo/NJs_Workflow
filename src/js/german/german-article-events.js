/**
 * german-article-events.js — 文章阅读模式事件层
 * -----------------------------------------------------------------------------
 * 职责：把"文章阅读子模式"的全部交互接在现有德语助手管线上：
 *   1. 子模式切换（查词 / 文章阅读）；
 *   2. 文章载入（含替换确认、空/超长/持久化失败的安全回滚）与清空；
 *   3. 点击正文词项 → 复用现有查词入口 runLookup（原词形，不做词形还原）；
 *      桌面端受视口约束的锚点浮窗，移动端全屏查词层；
 *   4. 逐段显式翻译（独立提示词 + 顺序处理 + 失败段独立重试 + 过长/持久化失败处理）；
 *   5. 幂等绑定（createGuard 多 host）、事件委托、可清理生命周期。
 *
 * 边界约束（与 german-events.js 一致）：
 *   - 本层只调 Store / Renderer / 现成 API，不复制 LLM 查询管线（runLookup 是唯一查词入口）；
 *   - 详情卡渲染复用 german-renderer 的 renderDetail(detail, container)，
 *     文章查词层容器经 bindDetailActions(scopeEl) 独立绑定一次；
 *   - 每个绑定独立异常隔离，单个失败不阻断其它模块。
 */

import { createGuard } from '../utils/guard.js'
import { I18N, t } from '../locales.js'
import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { openConfirmDialog } from '../settings/modal.js'

import {
  getGermanArticleState,
  getGermanArticleRevision,
  onGermanArticleStateChange,
  loadGermanArticle,
  setArticleMode,
  loadArticle,
  clearArticle,
  markParagraphPending,
  commitParagraphTranslation,
  failParagraphTranslation,
  MAX_PARAGRAPH_CHARS
} from './german-article-store.js'
import {
  setGermanArticleViewOpen,
  isGermanArticleViewOpen,
  setGermanArticleTranslationsHidden,
  isGermanArticleTranslationsHidden,
  applyTranslationVisibility,
  renderGermanArticle
} from './german-article-renderer.js'
import { runLookup, bindDetailActions, registerDictionarySwitcher } from './german-events.js'
import { renderDetail, renderSkeleton } from './german-renderer.js'
import { getGermanState, setLookupChannel } from './german-store.js'
import { getActiveProfile, hasAnkiCredentials } from '../anki/anki-store.js'
import { requestGemini, requestOpenAI } from '../anki/anki-api.js'

/* ====================================================================
 * DOM 获取（缺失时安全返回）
 * ==================================================================== */
function getArticleRoot() { return document.getElementById('german-article') }
function getBodyEl() { return document.getElementById('german-article-body') }
function getInputTextEl() { return document.getElementById('german-article-input') }
function getLoadBtn() { return document.getElementById('german-article-load') }
function getClearBtn() { return document.getElementById('german-article-clear') }
function getTranslateBtn() { return document.getElementById('german-article-translate') }
function getModeDictionary() { return document.getElementById('german-mode-dictionary') }
function getModeArticle() { return document.getElementById('german-mode-article') }

/** 共享查词层（桌面浮窗 / 移动全屏层同一定位根）。 */
function getLookupLayer() { return document.getElementById('german-article-lookup') }
function getLookupContent() { return document.getElementById('german-article-lookup-content') }
function getLookupClose() { return document.getElementById('german-article-lookup-close') }
function getLookupHeader() {
  const layer = getLookupLayer()
  return layer?.querySelector('.german-article-lookup__header') || null
}

/* ====================================================================
 * 幂等守卫（多 host：容器级各绑一次，文档级只绑一次）
 * ==================================================================== */
// 子模式切换按钮：两个按钮共享一个 host（文档）即可，重复进入模式不重复绑定。
const modeGuard = createGuard('germanArticleModeBound')
// 输入区操作（载入 / 清空 / 翻译 / 重新载入）：以文章根节点为 host。
const inputGuard = createGuard('germanArticleInputBound')
// 正文词项点击（事件委托）：以正文 body 为 host。
const bodyGuard = createGuard('germanArticleBodyBound')
// 查词层关闭 / 返回：以查词层为 host。
const lookupGuard = createGuard('germanArticleLookupBound')
// 查词层顶部拖动：以查词层为 host，避免重复注册 window 级 mousemove/mouseup。
const dragGuard = createGuard('germanArticleDragBound')

/* ====================================================================
 * 卡片显隐（Renderer 只写 data-article-mode，卡片层显交由事件层）
 * ====================================================================
 * 设计：Renderer 负责"内容"（段落 / 译文 DOM），事件层负责"可见性"。
 * 阅读卡片在 mode='reading' 且已有段落时显示；否则回退到输入卡片。
 * 该函数会被所有改变 state.mode / hasArticle 的入口调用。 */
function syncArticleCards() {
  const root = getArticleRoot()
  if (!root) return
  const state = getGermanArticleState()
  const inputCard = root.querySelector('.german-article__card--input')
  const readingCard = root.querySelector('.german-article__card--reading')
  // 两张子卡片（载入 / 阅读）始终可见，仅互斥显隐：
  //   - reading 为 true 时显示"阅读正文"卡、隐藏"载入"卡；
  //   - 否则显示"载入"卡、隐藏"阅读正文"卡。
  // reading 同时要求当前处于文章阅读子模式（_viewOpen）+ 有文章 + 有段落，
  // 保证查词模式下即使 store.mode 因启动恢复被置 'reading' 也不漏出阅读正文。
  const reading =
    isGermanArticleViewOpen() &&
    state.mode === 'reading' &&
    state.hasArticle &&
    state.paragraphs.length > 0
  if (inputCard) inputCard.hidden = reading
  if (readingCard) readingCard.hidden = !reading
}

/** 同步卡片显隐 + 翻译按钮文案，在每次渲染后统一调用。 */
function syncArticleUI() {
  syncArticleCards()
  syncTranslateButtonLabel()
}

/**
 * 启动归位到查词子模式：
 *   store 在 loadGermanArticle 时若恢复了文章会把 mode 置为 'reading'，
 *   但应用启动默认子模式是查词，需强制 setArticleMode('input')，
 *   让 syncArticleCards 显示"载入文章"卡（而非阅读正文），避免直接漏出持久化文章。
 */
function resetArticleViewOnBoot() {
  setArticleMode('input')
  setGermanArticleViewOpen(false)
  closeLookupLayer()
  setLookupChannel('assistant')
}

/* ====================================================================
 * 子模式切换（查词 / 文章阅读）
 * ==================================================================== */

/**
 * 进入文章阅读子模式：
 *   - 恢复上次持久化文章（loadGermanArticle 已在启动时跑过，这里仅渲染当前快照）；
 *   - 打开查词层容器（若存在未完成的词）并同步开关状态。
 */
function openArticleMode() {
  if (isGermanArticleViewOpen()) return
  setGermanArticleViewOpen(true)
  const state = getGermanArticleState()
  renderGermanArticle(state)
  syncArticleUI()
  DBG('german-article:enter')
}

/** 回到查词子模式：关闭文章阅读 UI，普通查词区恢复。 */
function closeArticleMode() {
  if (!isGermanArticleViewOpen()) return
  // 退出阅读模式时同时收起查词层，避免残留浮窗 / 全屏层。
  closeLookupLayer()
  // 查词通道归位：文章点词会把 store 的 lookupChannel 置为 'article'，
  // 若不在退出时复位，renderGermanAssistant 会持续短路，导致普通查词候选框不显示。
  setLookupChannel('assistant')
  // 复位译文显隐状态：切回查词后按钮应恢复"翻译全文"文案
  setGermanArticleTranslationsHidden(false)
  setGermanArticleViewOpen(false)
  const state = getGermanArticleState()
  renderGermanArticle(state)
  syncArticleUI()
  DBG('german-article:exit')
}

/** 绑定子模式切换按钮（委托在文档上，两个 mode 按钮共用）。 */
function bindModeSwitch() {
  if (modeGuard.is(document)) return
  modeGuard.set(document)

  // 向常规查词事件层注册"自动切回查词模式"回调：
  // 用户在文章阅读子模式下做常规查词（输入搜索框 / 点候选 / 重试）时，
  // german-events 会在 runSuggest / 候选点击 / 重试处调用本回调。
  registerDictionarySwitcher(() => {
    if (!isGermanArticleViewOpen()) return
    setArticleMode('input')
    closeArticleMode()
  })

  const dict = getModeDictionary()
  if (dict) {
    dict.addEventListener('click', () => {
      // 切回查词：关闭阅读子模式（Store mode 同步为 input）
      setArticleMode('input')
      closeArticleMode()
    })
  }
  const art = getModeArticle()
  if (art) {
    art.addEventListener('click', () => {
      setArticleMode(getGermanArticleState().hasArticle ? 'reading' : 'input')
      openArticleMode()
    })
  }
  DBG('german-article:mode-bound')
}

/* ====================================================================
 * 文章载入 / 清空 / 重新载入
 * ==================================================================== */

/**
 * 载入当前输入框中的文章。
 * 已有文章时先弹确认（替换语义）；取消或失败则保留旧文章与译文。
 */
async function handleLoad() {
  const textEl = getInputTextEl()
  if (!textEl) return
  const raw = textEl.value
  const state = getGermanArticleState()

  // 已存在文章 → 必须先确认替换（spec：替换已有文章必须确认）
  if (state.hasArticle) {
    const copy = I18N.german?.article || {}
    const confirmed = await openConfirmDialog({
      title: copy.replaceConfirmTitle,
      message: copy.replaceConfirmMessage,
      confirmText: copy.replaceConfirmOk,
      cancelText: t(I18N.common.cancel),
      danger: true
    })
    if (!confirmed) return
  }

  const result = loadArticle(raw)
  const copy = I18N.german?.article || {}
  if (!result.ok) {
    // 失败原因码 → 可理解提示；旧文章与译文保持不变（Store 已回滚）
    if (result.reason === 'empty') {
      showToast(copy.inputEmpty, { status: 'info' })
    } else if (result.reason === 'too_long') {
      showToast(t(copy.tooLong, { limit: MAX_PARAGRAPH_CHARS * 5 }), { status: 'error' })
    } else {
      showToast(copy.loadFailed, { status: 'error' })
    }
    DBG('german-article:load-failed', { reason: result.reason })
    return
  }

  // 成功：切到阅读模式并渲染（Store 已 emit，renderGermanArticle 由订阅驱动，
  // 这里显式调用一次确保首帧，随后清空输入框）
  textEl.value = ''
  // 新文章替换旧文章时立即使旧的顺序翻译循环失效。
  translateTaskToken += 1
  // 新文章 → 复位译文显隐状态（按钮恢复"翻译全文"）
  setGermanArticleTranslationsHidden(false)
  openArticleMode()
  showToast(t(copy.loadSuccess, { count: getGermanArticleState().paragraphs.length }), { status: 'success' })
  DBG('german-article:loaded', {})
}

/** 清空当前文章（持久化失败时保留，不丢数据）。 */
function handleClear() {
  const copy = I18N.german?.article || {}
  const ok = clearArticle()
  if (ok) {
    // 清空文章会让全文翻译循环因 revision 变化退出；同时使旧任务无法继续。
    translateTaskToken += 1
    // 清空后回到输入子模式
    setArticleMode('input')
    // 清空后复位译文显隐状态
    setGermanArticleTranslationsHidden(false)
    showToast(copy.clearSuccess, { status: 'success' })
  } else {
    showToast(copy.clearFailed, { status: 'error' })
  }
  const inputText = getInputTextEl()
  if (inputText) inputText.value = ''
  closeLookupLayer()
  renderGermanArticle(getGermanArticleState())
  syncArticleUI()
  DBG('german-article:cleared', { ok })
}

/** 绑定输入区按钮。 */
function bindInputActions() {
  const root = getArticleRoot()
  if (!root) return
  if (inputGuard.is(root)) return
  inputGuard.set(root)

  const load = getLoadBtn()
  if (load) load.addEventListener('click', () => { handleLoad() })

  const clear = getClearBtn()
  if (clear) clear.addEventListener('click', () => {
    handleClear()
  })

  const translate = getTranslateBtn()
  if (translate) translate.addEventListener('click', () => {
    try {
      handleTranslateButtonClick()
    } catch (error) {
      // 兜底：同步异常（如 Store 快照读取失败）不阻断其它按钮
      DBG('german-article:translate-click:exception', { err: String(error) })
    }
  })
  DBG('german-article:input-bound')
}

/* ====================================================================
 * 正文词项 → 查词（桌面浮窗 / 移动全屏层）
 * ==================================================================== */

// 当前查词锚点元素（用于浮窗定位）；查词层打开的竞态序号（旧请求不覆盖新词）
let lookupAnchorEl = null
let lookupSeq = 0
let lookupOpen = false
// 记录拖拽起点，支持桌面端拖动顶部改位置；拖拽中用 dragOffset 记录当前位移
let dragStartX = 0
let dragStartY = 0
let dragOriginX = 0
let dragOriginY = 0
let isDragging = false

/** 是否移动端（与 responsive.css 断点一致：≤680px 走全屏层）。 */
function isMobile() {
  return window.matchMedia('(max-width: 680px)').matches
}

/** 打开通用查词层并挂载详情容器的事件委托（bindDetailActions 多 host 幂等）。 */
function openLookupLayer() {
  const layer = getLookupLayer()
  if (!layer) return
  // 清除桌面定位内联样式，让 CSS 默认规则（mobile media query / 初始 fixed 定位）重新接管。
  // 修复：桌面态拖动或定位后，窗口缩到 ≤680px 时内联 left/top/width/maxHeight 优先级高于
  // media query 的 inset:0，导致全屏层失效、查词层跑到视口外。
  layer.style.left = ''
  layer.style.top = ''
  layer.style.width = ''
  layer.style.maxHeight = ''
  layer.hidden = false
  layer.setAttribute('aria-hidden', 'false')
  lookupOpen = true
  // 查词层容器独立绑定一次详情按钮委托（发音 / 加词 / 重取 / 搭配）
  const content = getLookupContent()
  if (content) bindDetailActions(content)
  const close = getLookupClose()
  if (close) close.focus()
  DBG('german-article:lookup-open', { mobile: isMobile() })
}

/** 关闭查词层，恢复文章焦点；查词层本身不锁 body，故无滚动锁残留。 */
function closeLookupLayer() {
  const layer = getLookupLayer()
  if (!layer) return
  layer.hidden = true
  layer.setAttribute('aria-hidden', 'true')
  lookupOpen = false
  lookupAnchorEl = null
  // 恢复焦点到最近点击且仍有效的词项；否则清除标记并回到模式切换按钮
  const focused = document.querySelector('.german-article__word[aria-current="true"]')
  if (focused && focused.isConnected) {
    focused.removeAttribute('aria-current')
    focused.focus({ preventScroll: true })
  } else {
    const art = getModeArticle()
    if (art) art.focus({ preventScroll: true })
  }
  DBG('german-article:lookup-close')
}

/**
 * 点击正文词项：以原始词形走现有查词管线，结果渲染到查词层共享容器。
 * 来源/锚点管理：
 *   - 记录锚点元素，浮窗以其为基准定位并受视口约束；
 *   - 每次点击 lookupSeq+1，旧请求 resolve/fail 时序号不匹配即丢弃（竞态防护）。
 */
async function handleWordClick(word, btnEl) {
  if (!word) return
  const seq = ++lookupSeq
  // 清除上一个词项的 aria-current，仅保留当前点击项（关闭时焦点回到这里）
  const prev = document.querySelector('.german-article__word[aria-current="true"]')
  if (prev && prev !== btnEl) prev.removeAttribute('aria-current')
  lookupAnchorEl = btnEl || null
  if (btnEl) btnEl.setAttribute('aria-current', 'true')

  openLookupLayer()
  // 立即定位到锚点词项，使浮窗一开始就出现在正确位置（而非左上角）。
  // 此时 lookupAnchorEl 已记录，positionLookupFloat 直接读取其视口坐标做夹紧；
  // 后续网络结果返回时 repositionOnLayoutChange 若锚点未变则位置不变（不跳动）。
  positionLookupFloat()
  // 先显示骨架（普通详情区被 renderGermanAssistant 短路，必须显式渲染到查词层容器）
  const content = getLookupContent()
  if (content) {
    renderSkeleton(content)
  }

  const result = await runLookup(word, { scopeEl: content, channel: 'article' })

  // 竞态防护：期间又点了别的词 → 本次结果直接丢弃，不覆盖新词的锚点与浮窗
  if (seq !== lookupSeq) return

  // runLookup 内部已 resolveLookup/failLookup 更新 german-store；
  // 文章模式下 renderGermanAssistant 短路，故此处显式渲染到查词层容器。
  const state = getGermanState()
  if (!state) return
  if (content) {
    if (state.detailLoading) {
      renderSkeleton(content)
    } else if (state.detailError) {
      content.replaceChildren()
      content.hidden = true
    } else if (state.detail) {
      renderDetail(state.detail, content)
    }
  }

  if (result && result.ok && result.detail) {
    // 通过 repositionOnLayoutChange 定位（内部检测移动端直接 return），
    // 避免桌面→移动端切换后 positionLookupFloat 误写入内联样式导致全屏层失效。
    repositionOnLayoutChange()
  }
  DBG('german-article:word-lookup', { word, ok: !!(result && result.ok) })
}

/**
 * 桌面浮窗定位：以锚点词项为基准，水平/垂直都约束在视口内；
 * 锚点缺失或不可定位时退化为视口内可见的固定位置（spec：浮窗必须保持可见）。
 */
function positionLookupFloat() {
  if (isMobile()) return // 移动端全屏层，无需定位
  const layer = getLookupLayer()
  if (!layer || layer.hidden) return

  const vw = window.innerWidth
  const vh = window.innerHeight
  const margin = 12
  // 竖向 3:4 查词浮窗：宽度由高度反推；拖拽时直接用当前坐标夹边界，
  // 避免每次重新定位把用户拖到合适的位置又打回去。
  let layerHeight = Math.min(vh - 2 * margin, 560)
  let width = Math.min(680, Math.max(360, Math.floor(layerHeight * (3 / 4))))
  let x = 24
  let y = 24

  if (!isDragging && lookupAnchorEl && lookupAnchorEl.getBoundingClientRect) {
    const rect = lookupAnchorEl.getBoundingClientRect()
    x = rect.left + rect.width / 2 - width / 2
    y = rect.bottom + margin
  }

  // 先按 3:4 同步宽高：宽度或高度任一被视口限制时，另一边也要同步收紧。
  if (width + 2 * margin > vw) {
    width = Math.max(360, Math.min(width, vw - 2 * margin))
    layerHeight = Math.max(280, Math.floor(width * (4 / 3)))
  }
  if (layerHeight + 2 * margin > vh) {
    layerHeight = Math.max(280, vh - 2 * margin)
    width = Math.max(360, Math.floor(layerHeight * (3 / 4)))
  }

  // 垂直约束：若下方放不下则改到锚点上方；拖拽期间只夹逼，不回锚。
  if (!isDragging && y + layerHeight > vh - margin) {
    const anchorTop = lookupAnchorEl?.getBoundingClientRect?.().top
    y = (anchorTop && anchorTop > layerHeight + margin)
      ? anchorTop - layerHeight - margin
      : Math.max(margin, vh - layerHeight - margin)
  }
  if (!isDragging && x + width > vw - margin) {
    x = Math.max(margin, vw - width - margin)
  }
  x = Math.max(margin, Math.min(x, vw - width - margin))
  y = Math.max(margin, Math.min(y, vh - layerHeight - margin))

  layer.style.position = 'fixed'
  layer.style.left = x + 'px'
  layer.style.top = y + 'px'
  layer.style.width = width + 'px'
  layer.style.maxHeight = layerHeight + 'px'
}

/** 拖动顶部改位置：拖动开始时记录原位置，移动时更新 x/y 并夹到视口内。 */
function bindLookupDrag() {
  const layer = getLookupLayer()
  if (!layer) return
  if (dragGuard.is(layer)) return
  dragGuard.set(layer)

  const header = getLookupHeader()
  if (!header) return
  header.style.cursor = 'grab'

  header.addEventListener('mousedown', (event) => {
    if (isMobile()) return
    // 点击关闭按钮时不进入拖拽，避免误移动
    const closeBtn = getLookupClose()
    if (closeBtn && closeBtn.contains(event.target)) return
    event.preventDefault()
    isDragging = true
    dragStartX = event.clientX
    dragStartY = event.clientY
    const rect = layer.getBoundingClientRect()
    dragOriginX = rect.left
    dragOriginY = rect.top
    header.style.cursor = 'grabbing'
  })

  window.addEventListener('mousemove', (event) => {
    if (!isDragging) return
    const dx = event.clientX - dragStartX
    const dy = event.clientY - dragStartY
    const vw = window.innerWidth
    const vh = window.innerHeight
    const margin = 12
    const w = layer.offsetWidth || 480
    const h = layer.offsetHeight || 640
    let x = dragOriginX + dx
    let y = dragOriginY + dy
    x = Math.max(margin, Math.min(x, vw - w - margin))
    y = Math.max(margin, Math.min(y, vh - h - margin))
    layer.style.left = x + 'px'
    layer.style.top = y + 'px'
  }, { passive: true })

  window.addEventListener('mouseup', () => {
    if (!isDragging) return
    isDragging = false
    header.style.cursor = 'grab'
    // 拖拽结束保留当前位置，不回跳锚点；下一次换词或窗口缩放时再自动定位
  }, { passive: true })
}

/** 窗口尺寸变化 / 滚动时重新定位浮窗（仅桌面且查词层打开时）。 */
function repositionOnLayoutChange() {
  if (!lookupOpen) return
  const layer = getLookupLayer()
  if (!layer) return
  if (isMobile()) {
    // 桌面→移动端切换：清除桌面态写入的内联定位样式，让 media query 的
    // inset:0 + height:100dvh 全屏规则重新接管，避免查词层跑到视口外。
    layer.style.left = ''
    layer.style.top = ''
    layer.style.width = ''
    layer.style.maxHeight = ''
    return
  }
  // 移动端→桌面：resize 触发此路径，正常重新定位浮窗
  if (isDragging) return
  positionLookupFloat()
}

/** 绑定正文词项点击（事件委托在 body 上）。 */
function bindBodyWordClick() {
  const body = document.getElementById('german-article-body')
  if (!body) return
  if (bodyGuard.is(body)) return
  bodyGuard.set(body)

  body.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : event.target?.parentElement
    const wordBtn = target?.closest('.german-article__word')
    if (!wordBtn || !body.contains(wordBtn)) return
    const word = wordBtn.dataset.word
    handleWordClick(word, wordBtn)
  })

  // 译文段"重试"按钮：委托，携带段落索引
  body.addEventListener('click', (event) => {
    const retry = event.target.closest('.german-article__translation-retry')
    if (!retry) return
    const index = Number(retry.dataset.paragraphIndex)
    try {
      translateParagraph(index).catch((error) => {
        DBG('german-article:retry:exception', { index, err: String(error) })
      })
    } catch (error) {
      DBG('german-article:retry:sync-exception', { index, err: String(error) })
    }
  })
  DBG('german-article:body-bound')
}

/** 绑定查词层关闭 / 返回。 */
function bindLookupClose() {
  const layer = getLookupLayer()
  if (!layer) return
  if (lookupGuard.is(layer)) return
  lookupGuard.set(layer)

  const close = getLookupClose()
  if (close) close.addEventListener('click', () => closeLookupLayer())

  // 桌面：点击浮窗外任意处关闭（mousedown 先于 click，避免与浮窗内操作冲突）
  document.addEventListener('mousedown', (event) => {
    if (!lookupOpen) return
    if (isMobile()) return // 移动端全屏层用返回按钮，不随手势关闭
    if (layer.contains(event.target)) return
    closeLookupLayer()
  })

  window.addEventListener('resize', repositionOnLayoutChange)
  // 不监听 scroll：查词层是 position:fixed（挂载于 .app-shell，不受 .view transform 影响），
  // 本身已钉在视口。若在滚动时重算锚点坐标，浮窗会随页面滚动不断重新吸附而出现跳动。
  DBG('german-article:lookup-bound')
}

/* ====================================================================
 * 逐段翻译（独立提示词 + 顺序处理 + 复用现有 API 请求配置）
 * ==================================================================== */

// 逐段翻译重入守卫：同一时刻只允许一个"翻译全文"循环在跑，
// 避免用户连点"翻译全文"造成重复请求与段落错位。
let translatingInFlight = false
// 翻译任务令牌：每次启动"翻译全文"递增，循环中检测令牌是否匹配当前任务。
// 文章替换/清空后 revision 变化，旧任务的令牌不再匹配，循环立即退出。
let translateTaskToken = 0

/** 段落翻译的 LLM 系统提示词：只翻译该段，不总结、不加注释。 */
const TRANSLATE_SYSTEM_PROMPT = [
  '你是一名严谨的德中翻译助手。用户会给你一个德语段落，请把它翻译成简体中文。',
  '',
  '规则：',
  '1. 只翻译用户给出的这一段，不要总结、改写或添加任何注释、解释。',
  '2. 保留原文语气与含义；专有名词首次出现可保留德语并附中文。',
  '3. 直接输出译文本身，不要输出"译文："等前缀，也不要 markdown。'
].join('\n')

/**
 * 翻译单个段落（用户显式启动 / 失败段重试共用）。
 * 成功才提交持久化；持久化失败不得标记完成；过长段在请求前提示、不静默截断。
 */
async function translateParagraph(index, expectedRevision = getGermanArticleRevision()) {
  const state = getGermanArticleState()
  if (!state || !state.hasArticle || expectedRevision !== getGermanArticleRevision()) return false
  const paragraph = state.paragraphs[index]
  if (!paragraph) return false
  const copy = I18N.german?.article || {}

  // 已完成段不重复请求
  const entry = state.translations[index]
  if (entry && entry.status === 'done') return true

  // 过长段：明确提示，允许手动拆分，不静默截断
  if (paragraph.text.length > MAX_PARAGRAPH_CHARS) {
    showToast(t(copy.paragraphTooLong, { index: index + 1, limit: MAX_PARAGRAPH_CHARS }), { status: 'error' })
    failParagraphTranslation(index, copy.translationFailed || '翻译失败', expectedRevision)
    return false
  }

  // 检查 LLM 凭证（复用 Anki 设置中的 API Key / 模型，与查词同源）
  if (!hasAnkiCredentials()) {
    showToast(copy.noCredentials || '请先在「设置」中配置 AI API Key 与模型。', { status: 'error' })
    failParagraphTranslation(index, copy.noCredentials || '未配置 AI 凭证', expectedRevision)
    return false
  }

  if (!markParagraphPending(index, expectedRevision)) return false

  const activeProfile = getActiveProfile() || {}
  let result
  try {
    result = activeProfile.apiType === 'openai'
      ? await requestOpenAI({
          baseUrl: activeProfile.baseUrl,
          modelId: activeProfile.modelId,
          apiKey: activeProfile.apiKey,
          systemPrompt: TRANSLATE_SYSTEM_PROMPT,
          userMessage: paragraph.text
        })
      : await requestGemini({
          baseUrl: activeProfile.baseUrl,
          modelId: activeProfile.modelId,
          apiKey: activeProfile.apiKey,
          systemPrompt: TRANSLATE_SYSTEM_PROMPT,
          userMessage: paragraph.text
        })
  } catch (err) {
    DBG('german-article:translate:exception', { index, err: String(err) })
    failParagraphTranslation(index, copy.translationFailed || '翻译失败', expectedRevision)
    return false
  }

  if (expectedRevision !== getGermanArticleRevision()) return false
  if (!result || !result.ok) {
    failParagraphTranslation(index, result?.error || copy.translationFailed || '翻译失败', expectedRevision)
    return false
  }

  const translated = String(result.text || '').trim()
  if (!translated) {
    failParagraphTranslation(index, copy.translationFailed || '翻译失败', expectedRevision)
    return false
  }

  const commit = commitParagraphTranslation(index, translated, expectedRevision)
  if (!commit.ok) {
    if (commit.reason === 'stale_article') return false
    showToast(copy.saveFailed || '译文保存失败，请检查浏览器存储。', { status: 'error' })
    failParagraphTranslation(index, copy.saveFailed || '保存失败', expectedRevision)
    return false
  }
  DBG('german-article:translate:paragraph', { index, ok: true })
  return true
}

/**
 * 全文顺序翻译：从首段开始逐段处理，跳过已完成段。
 * 失败段不停止后续（用户可单独重试），但保留已成功段。
 * 文章替换/清空后 revision 变化，循环立即退出，不向新文章提交旧译文。
 */
async function handleTranslateAll() {
  if (translatingInFlight) return
  const state = getGermanArticleState()
  if (!state || !state.hasArticle || state.paragraphs.length === 0) return

  const expectedRevision = getGermanArticleRevision()
  const taskToken = ++translateTaskToken
  translatingInFlight = true
  const copy = I18N.german?.article || {}
  const total = state.paragraphs.length

  try {
    // 顺序处理：每段前检测 revision 与任务令牌，任一变化则立即退出，
    // 避免向新文章提交旧译文、避免旧循环占用 translatingInFlight。
    for (const paragraph of state.paragraphs) {
      if (expectedRevision !== getGermanArticleRevision() || taskToken !== translateTaskToken) break
      const current = getGermanArticleState()
      if (!current || !current.hasArticle || expectedRevision !== getGermanArticleRevision() || taskToken !== translateTaskToken) break
      const entry = current.translations[paragraph.index]
      if (entry && entry.status === 'done') continue
      await translateParagraph(paragraph.index, expectedRevision)
    }

    if (expectedRevision !== getGermanArticleRevision() || taskToken !== translateTaskToken) return
    const final = getGermanArticleState()
    const succeeded = Object.keys(final.translations || {})
      .filter((k) => final.translations[k] && final.translations[k].status === 'done').length
    if (succeeded === total) {
      // 全部翻译成功：进入"显示译文"初始态（按钮变为"隐藏译文"）
      setGermanArticleTranslationsHidden(false)
      showToast(t(copy.translateDone, { done: succeeded, total }), { status: 'success' })
    } else if (succeeded > 0) {
      showToast(t(copy.translatePartial, { done: succeeded, total }), { status: 'error' })
    }
    syncTranslateButtonLabel()
  } catch (error) {
    // 翻译循环异常兜底：确保 translatingInFlight 在 finally 中清除，
    // 并输出诊断信息。单个段落的异常已由 translateParagraph 内部捕获，
    // 此处兜底的是循环框架本身的意外错误（如快照读取失败等）。
    DBG('german-article:translate-all:exception', { err: String(error) })
    syncTranslateButtonLabel()
  } finally {
    translatingInFlight = false
  }
  DBG('german-article:translate-all-done')
}

/**
 * 译文显隐切换：委托渲染层统一管理显隐状态，避免事件层本地变量在 PubSub
 * 重建/增量同步后失效。该状态仅在文章阅读子模式内有效（closeArticleMode 复位）。
 */
function toggleTranslationVisibility() {
  const next = !isGermanArticleTranslationsHidden()
  setGermanArticleTranslationsHidden(next)
  syncTranslateButtonLabel()
  DBG('german-article:toggle-translation', { hidden: next })
}

/** 点"翻译全文"按钮：有剩余未译段 → 继续翻译；已全部译完 → 切换译文显隐。 */
function handleTranslateButtonClick() {
  const state = getGermanArticleState()
  if (!state || !state.hasArticle || state.paragraphs.length === 0) return
  const doneCount = Object.keys(state.translations || {})
    .filter((k) => state.translations[k] && state.translations[k].status === 'done').length
  const hasRemaining = state.paragraphs.length > 0 && doneCount < state.paragraphs.length
  if (hasRemaining) {
    handleTranslateAll()
  } else {
    toggleTranslationVisibility()
  }
}

/** 把按钮文案在"翻译全文 / 继续翻译 / 隐藏译文 / 显示译文"之间切换。 */
function syncTranslateButtonLabel() {
  const btn = getTranslateBtn()
  if (!btn) return
  const state = getGermanArticleState()
  const copy = I18N.german?.article || {}
  if (!state || !state.hasArticle) return
  const doneCount = Object.keys(state.translations || {})
    .filter((k) => state.translations[k] && state.translations[k].status === 'done').length
  const total = state.paragraphs.length || 0
  const hasRemaining = total > 0 && doneCount < total
  if (doneCount === 0) {
    // 尚未开始翻译
    btn.textContent = copy.translateAll || '翻译全文'
  } else if (hasRemaining) {
    // 部分已译、部分未译：提示"继续翻译"
    btn.textContent = copy.translateRemaining || '继续翻译'
  } else {
    // 全部译完：根据当前显隐态切换
    btn.textContent = isGermanArticleTranslationsHidden() ? (copy.showTranslation || '显示译文') : (copy.hideTranslation || '隐藏译文')
  }
  // 不再禁用按钮：未译完可"继续翻译"，全译完可"切换显隐"
  btn.disabled = false
}

/* ====================================================================
 * 公开绑定入口（app.js 以独立 try/catch + stage:'bind_german-article' 调用）
 * ==================================================================== */

/**
 * 绑定文章阅读模式全部事件（幂等）。
 * 可选 DOM 缺失时安全返回；单一绑定失败不阻断其它绑定。
 */
export function bindGermanArticleEvents() {
  const root = getArticleRoot()
  if (!root) {
    DBG('german-article:bind-skip', { reason: 'no-root' })
    return
  }

  const steps = [
    { name: 'mode', fn: bindModeSwitch },
    { name: 'input', fn: bindInputActions },
    { name: 'body', fn: bindBodyWordClick },
    { name: 'lookup', fn: bindLookupClose },
    { name: 'drag', fn: bindLookupDrag }
  ]
  for (const step of steps) {
    try {
      step.fn()
    } catch (error) {
      // 逐绑定隔离：单个失败不阻断其它文章事件
      DBG('german-article:bind-failed', { step: step.name, err: String(error) })
    }
  }
  DBG('german-article:bound')
}

/**
 * 启动文章模块：恢复持久化文章 + 渲染首帧 + 订阅状态变化驱动渲染。
 * 与 bindGermanArticleEvents 分离，方便 app.js 在独立异常边界中分别调用。
 */
export function initGermanArticle() {
  // 启动恢复：读取本地持久化文章（无则保持空态）
  loadGermanArticle()
  // 启动默认子模式是"查词"：把 store.mode 归位为 input 并关闭文章容器，
  // 避免恢复了文章后（store 置 mode='reading'）阅读卡直接漏到查词页面上。
  resetArticleViewOnBoot()
  const state = getGermanArticleState()
  renderGermanArticle(state)
  syncArticleUI()
  return onGermanArticleStateChange((next) => {
    renderGermanArticle(next)
    syncArticleUI()
  })
}

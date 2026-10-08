/**
 * german-article-store.js — 文章阅读模式状态 Store（版本化持久化 + PubSub）
 * -----------------------------------------------------------------------------
 * 职责：管理"当前文章"这一段独立持久化数据（有且仅有一篇）：
 *   - 文章原文、按段落解析结果、逐段译文状态；
 *   - 阅读/输入子模式（mode，仅内存态，不持久化）。
 * 边界：Store 只管状态，不操作 DOM；Renderer 只读快照；Events 只调方法。
 *
 * 关键一致性约束（与 german-font-size.js 相同的"先落盘后发布"模式）：
 *   持久化成功后才更新内存并发布 PubSub；持久化失败必须回滚内存，
 *   保留旧文章与旧译文，绝不发布"伪成功"状态。
 *
 * 为什么单独一个 key：
 *   文章体积远大于其它德语状态，且生命周期完全独立（替换/恢复），
 *   与 njs-german-cache（词条缓存）分开放，避免整块序列化互相拖累。
 *
 * schema 版本化：
 *   文档带 version 字段。遇到未知版本或损坏字段时安全降级——尽力恢复
 *   可用文章文本，忽略无效译文，绝不因解析失败阻断德语助手启动。
 */

import { createPubSub } from '../utils/pubsub.js'
import { safeStorageGet, safeStorageSet, safeStorageRemove } from '../core/storage.js'
import { DBG } from '../core/debug.js'

/** 独立存储 key（与德语助手其它持久化互不干扰）。 */
export const ARTICLE_STORAGE_KEY = 'njs-german-article'

/** 当前 schema 版本；后续结构变更时递增并在 normalize 中做兼容。 */
export const ARTICLE_SCHEMA_VERSION = 1

/** 文章总长度产品上限：超出则拒绝载入（不静默截断），提示用户自行精简。 */
export const MAX_ARTICLE_CHARS = 20000

/**
 * 单段翻译长度上限：超过则在该段请求前明确提示过长，允许用户手动拆分，
 * 不做静默截断或跨段错位合并。
 */
export const MAX_PARAGRAPH_CHARS = 4000

const pubsub = createPubSub()

/**
 * 内存状态（只读快照的来源）。
 * - translations 以段落索引为 key，值为 { status, text, error }：
 *     status: 'pending' | 'done' | 'error'
 *     'pending' / 'error' 为瞬时 UI 态，不落盘；只有 'done' 会持久化。
 * - mode 仅内存态：刷新后若存在可恢复文章，一律回到 'reading'（阅读位置回到顶部）。
 */
function createEmptyState() {
  return {
    mode: 'input',      // 'input' | 'reading'
    hasArticle: false,
    articleText: '',
    paragraphs: [],     // [{ index, text, separator, trailing }]
    translations: {},   // { [index]: { status, text, error } }
    loadedAt: 0
  }
}

let state = createEmptyState()
let articleRevision = 0

/* ====================================================================
 * 段落解析（保真核心）
 * ==================================================================== */

/**
 * 按"空行"切分文章为段落，并保留段落之间的原始空白分隔符。
 *
 * 为什么保留分隔符：
 *   阅读视图是"词语按钮 + 文本节点"拼装而成，若丢弃空行原文，
 *   重建后的纯文本无法与输入逐字符一致。因此每个段落额外记录
 *   separator（其前导空白）与 trailing（末段之后的空白），
 *   以便渲染层能 1:1 还原换行与空行。
 *
 * @param {string} src 原始文章文本
 * @returns {Array<{index:number,text:string,separator:string,trailing:string}>}
 */
export function parseArticleParagraphs(src) {
  const raw = String(src || '')
  if (!raw.trim()) return []
  // 捕获组决定 split 结果会保留分隔符：偶数下标为段落块，奇数下标为分隔符。
  // 分隔符 = 一个换行 + 行内空白 + 一个或多个换行（即一个及以上空行）。
  const tokens = raw.split(/(\r?\n[ \t]*\r?\n+)/)
  const out = []
  let pending = ''
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (i % 2 === 1) {
      // 分隔符累积到"下一个段落"前；若原文以空行结尾，最终落到末段 trailing。
      pending += tok
      continue
    }
    if (tok.length === 0) continue
    out.push({ index: out.length, text: tok, separator: pending, trailing: '' })
    pending = ''
  }
  if (pending && out.length) out[out.length - 1].trailing = pending
  return out
}

/* ====================================================================
 * 规范化 / 降级
 * ==================================================================== */

/** 把任意持久化片段规范为合法段落数组；无效项被丢弃。 */
function normalizeParagraphs(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    let text = ''
    let separator = ''
    let trailing = ''
    if (typeof item === 'string') {
      text = item
    } else if (item && typeof item === 'object') {
      text = typeof item.text === 'string' ? item.text : ''
      separator = typeof item.separator === 'string' ? item.separator : ''
      trailing = typeof item.trailing === 'string' ? item.trailing : ''
    }
    if (!text) continue
    out.push({ index: out.length, text, separator, trailing })
  }
  return out
}

/**
 * 规范逐段译文：只保留 'done' 且文本非空、索引在有效范围内的条目。
 * 'pending' / 'error' / 未知状态一律丢弃——它们不是"有效译文"。
 */
function normalizeTranslations(raw, paragraphCount) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const key of Object.keys(raw)) {
    const i = Number(key)
    if (!Number.isInteger(i) || i < 0 || i >= paragraphCount) continue
    const entry = raw[key]
    if (!entry || typeof entry !== 'object') continue
    if (entry.status !== 'done') continue
    const text = typeof entry.text === 'string' ? entry.text.trim() : ''
    if (!text) continue
    out[i] = { status: 'done', text, error: '' }
  }
  return out
}

/**
 * 把持久化文档规范化为可用状态；无法恢复时返回 null。
 * 未知 version 不直接拒绝：尽力恢复可识别字段（安全降级）。
 * 恢复后校验 articleText 长度不超过产品上限，避免旧版超限数据重新进入内存。
 */
function normalizeArticleDoc(raw) {
  if (!raw || typeof raw !== 'object') return null
  const articleText = typeof raw.articleText === 'string' ? raw.articleText : ''
  if (!articleText.trim()) return null
  // 超限文章拒绝恢复（安全降级：丢弃整篇，避免渲染超大 DOM）
  if (articleText.length > MAX_ARTICLE_CHARS) {
    DBG('german-article:normalize:too-long', { length: articleText.length })
    return null
  }

  let paragraphs = normalizeParagraphs(raw.paragraphs)
  if (paragraphs.length === 0) paragraphs = parseArticleParagraphs(articleText)
  if (paragraphs.length === 0) return null

  // 段落重建一致性校验：把持久化段落的 text+separator+trailing 拼回，
  // 若与 articleText 不一致则退回从 articleText 重新解析，保证段落索引与原文对齐。
  if (raw.paragraphs && paragraphs.length > 0) {
    const reconstructed = paragraphs.map(p => p.separator + p.text).join('')
      + (paragraphs[paragraphs.length - 1]?.trailing || '')
    if (reconstructed !== articleText) {
      const reparsed = parseArticleParagraphs(articleText)
      if (reparsed.length > 0) paragraphs = reparsed
    }
  }

  const translations = normalizeTranslations(raw.translations, paragraphs.length)
  const loadedAt = Number.isFinite(raw.loadedAt) ? raw.loadedAt : Date.now()
  return { articleText, paragraphs, translations, loadedAt }
}

/* ====================================================================
 * 持久化
 * ==================================================================== */

/** 由内存状态构造待落盘文档（不含 mode / pending 等瞬时态）。 */
function buildDoc(s) {
  return {
    version: ARTICLE_SCHEMA_VERSION,
    articleText: s.articleText,
    paragraphs: s.paragraphs,
    translations: s.translations,
    loadedAt: s.loadedAt,
    updatedAt: Date.now()
  }
}

/* ====================================================================
 * 公开接口
 * ==================================================================== */

/**
 * 启动恢复：从存储读取并规范化当前文章。
 * 不 emit（此时订阅者通常尚未注册），由启动流程显式触发首帧渲染。
 * @returns {object} 恢复后的状态快照
 */
export function loadGermanArticle() {
  const raw = safeStorageGet(ARTICLE_STORAGE_KEY, null)
  const doc = normalizeArticleDoc(raw)
  if (!doc) {
    state = createEmptyState()
    // 存储里存在无法恢复的数据时清掉，避免每次启动重复走降级分支。
    if (raw !== null) {
      const removed = safeStorageRemove(ARTICLE_STORAGE_KEY)
      DBG('german-article:degraded', { reason: 'unrecoverable', removed })
    }
    return state
  }
  state = {
    mode: 'reading', // 有可恢复文章即回到阅读模式，滚动位置由渲染层从顶部开始
    hasArticle: true,
    articleText: doc.articleText,
    paragraphs: doc.paragraphs,
    translations: doc.translations,
    loadedAt: doc.loadedAt
  }
  DBG('german-article:restored', {
    paragraphs: doc.paragraphs.length,
    translations: Object.keys(doc.translations).length
  })
  return state
}

/** 只读状态快照（Renderer 使用，不得外部修改）。 */
export function getGermanArticleState() {
  return state
}

export function getGermanArticleRevision() {
  return articleRevision
}

/**
 * 订阅文章状态变化；返回取消订阅函数（供生命周期清理）。
 * @param {(state:object)=>void} fn
 * @returns {()=>void}
 */
export function onGermanArticleStateChange(fn) {
  return pubsub.on(fn)
}

/** 切换输入/阅读子模式（仅内存态，不做持久化，失败无副作用）。 */
export function setArticleMode(mode) {
  const next = mode === 'reading' ? 'reading' : 'input'
  if (next === state.mode) return true
  state = { ...state, mode: next }
  pubsub.emit(state)
  return true
}

/**
 * 载入（或原子替换）文章。
 * 成功：解析段落 → 清空旧译文 → 落盘成功后更新内存并发布。
 * 失败：内存回滚为旧状态，保留旧文章与旧译文，返回失败原因码。
 *
 * @param {string} rawText 用户输入的文章原文
 * @returns {{ok:boolean, reason?:string}} reason ∈ empty|too_long|persist_failed
 */
export function loadArticle(rawText) {
  const text = typeof rawText === 'string' ? rawText : ''
  if (!text.trim()) return { ok: false, reason: 'empty' }
  if (text.length > MAX_ARTICLE_CHARS) return { ok: false, reason: 'too_long' }

  const paragraphs = parseArticleParagraphs(text)
  if (paragraphs.length === 0) return { ok: false, reason: 'empty' }

  const nextRevision = articleRevision + 1
  const nextState = {
    mode: 'reading',
    hasArticle: true,
    articleText: text,
    paragraphs,
    translations: {},
    loadedAt: Date.now()
  }
  if (!safeStorageSet(ARTICLE_STORAGE_KEY, buildDoc(nextState))) {
    DBG('german-article:load:persist-failed', {})
    return { ok: false, reason: 'persist_failed' }
  }
  state = nextState
  articleRevision = nextRevision
  pubsub.emit(state)
  DBG('german-article:loaded', { paragraphs: paragraphs.length })
  return { ok: true }
}

/**
 * 标记某段开始翻译（瞬时 UI 态，不落盘，不视为完成）。
 * @returns {boolean} 索引是否有效
 */
export function markParagraphPending(index, expectedRevision = articleRevision) {
  if (!state.hasArticle || expectedRevision !== articleRevision) return false
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0 || i >= state.paragraphs.length) return false
  state = {
    ...state,
    translations: { ...state.translations, [i]: { status: 'pending', text: '', error: '' } }
  }
  pubsub.emit(state)
  return true
}

/**
 * 提交某段译文：仅当落盘成功后才标记为完成并发布。
 * 失败时不改变内存、不发布，返回失败原因（持久化失败不得伪报完成）。
 *
 * @param {number} index 段落索引
 * @param {string} translatedText 该段中文译文
 * @returns {{ok:boolean, reason?:string}} reason ∈ stale_article|no_article|bad_index|empty|persist_failed
 */
export function commitParagraphTranslation(index, translatedText, expectedRevision = articleRevision) {
  if (expectedRevision !== articleRevision) return { ok: false, reason: 'stale_article' }
  if (!state.hasArticle) return { ok: false, reason: 'no_article' }
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0 || i >= state.paragraphs.length) {
    return { ok: false, reason: 'bad_index' }
  }
  const text = typeof translatedText === 'string' ? translatedText.trim() : ''
  if (!text) return { ok: false, reason: 'empty' }

  const prev = state
  state = {
    ...state,
    translations: { ...state.translations, [i]: { status: 'done', text, error: '' } }
  }
  if (!safeStorageSet(ARTICLE_STORAGE_KEY, buildDoc(state))) {
    state = prev
    DBG('german-article:translate:persist-failed', { index: i })
    return { ok: false, reason: 'persist_failed' }
  }
  pubsub.emit(state)
  DBG('german-article:translate:committed', { index: i })
  return { ok: true }
}

/**
 * 标记某段翻译失败（瞬时 UI 态，不落盘），供界面展示错误与独立重试。
 * 已成功段不会因此被清除。
 */
export function failParagraphTranslation(index, message, expectedRevision = articleRevision) {
  if (!state.hasArticle || expectedRevision !== articleRevision) return false
  const i = Number(index)
  if (!Number.isInteger(i) || i < 0 || i >= state.paragraphs.length) return false
  state = {
    ...state,
    translations: {
      ...state.translations,
      [i]: { status: 'error', text: '', error: String(message || '') }
    }
  }
  pubsub.emit(state)
  return true
}

/**
 * 清空当前文章：落盘失败时保留原状态（不丢用户数据）。
 * @returns {boolean} 是否成功
 */
export function clearArticle() {
  const next = createEmptyState()
  if (!safeStorageRemove(ARTICLE_STORAGE_KEY)) {
    DBG('german-article:clear:persist-failed', {})
    return false
  }
  articleRevision += 1
  state = next
  pubsub.emit(state)
  DBG('german-article:cleared', {})
  return true
}

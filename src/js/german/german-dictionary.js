/**
 * german-dictionary.js — 本地德语候选词库（分层 JSON 索引 + 0 延迟模糊匹配）
 * -----------------------------------------------------------------------------
 * 设计目的：
 *   1. 首选：加载静态分层 JSON 索引
 *      - 首层 public/data/german/index-core.json（~5000 条高频词，启动即时可用）
 *      - 完整 public/data/german/index.json（~5 万条，按需加载后切换）
 *   2. 兜底：内置最小高频词库（加载失败时使用，保证 LLM 直接查询流程可用）
 *
 * 数据格式（JSON 索引）：{ search_term, word, pos, brief }
 *   - search_term: 小写 Unicode 规范化搜索键，用于前缀/包含匹配
 *   - word:        德语单词原型（保留原始大小写）
 *   - pos:         词性缩写
 *   - brief:       简明释义（中文优先，英文回退）
 *
 * 运行时扩展字段：
 *   - fuzzy_term:  纯字母检索键（ä→a, ö→o, ü→u），由 toFuzzyTerm 在加载时预计算
 *     用于非对称变音模糊匹配：无变音 query 同时命中变音/非变音词，有变音 query 只命中变音词
 *
 * 公开接口（不变）：
 *   searchLocalDictionary(query, limit = 8) → { word, pos, posLabel, zh }[]
 *   findLocalEntry(word) → { word, pos, zh } | null
 *   loadGermanDictionary() → Promise<void>（幂等，可重复调用）
 *   POS_LABELS
 */

import { DBG } from '../core/debug.js'

/* ---------------------------------------------------------------------------
 * 内置最小兜底词库（仅用于 JSON 加载失败时保持基本候选可用）
 * 保持 ~30 条最高频词，避免文件过大。
 * --------------------------------------------------------------------------- */
const FALLBACK_DICTIONARY = [
  { word: 'aber', pos: 'conj', zh: '但是' },
  { word: 'aber', pos: 'adv', zh: '然而' },
  { word: 'Abend', pos: 'n', zh: '晚上' },
  { word: 'Apfel', pos: 'n', zh: '苹果' },
  { word: 'Arzt', pos: 'n', zh: '医生' },
  { word: 'auch', pos: 'adv', zh: '也' },
  { word: 'auf', pos: 'prep', zh: '在…上面' },
  { word: 'aus', pos: 'prep', zh: '从…出来' },
  { word: 'Berg', pos: 'n', zh: '山' },
  { word: 'Bier', pos: 'n', zh: '啤酒' },
  { word: 'Blume', pos: 'n', zh: '花' },
  { word: 'Brot', pos: 'n', zh: '面包' },
  { word: 'das', pos: 'pron', zh: '这/那' },
  { word: 'drei', pos: 'adj', zh: '三' },
  { word: 'ein', pos: 'pron', zh: '一个' },
  { word: 'essen', pos: 'v', zh: '吃' },
  { word: 'Familie', pos: 'n', zh: '家庭' },
  { word: 'gehen', pos: 'v', zh: '走' },
  { word: 'Geld', pos: 'n', zh: '钱' },
  { word: 'haben', pos: 'v', zh: '有' },
  { word: 'gut', pos: 'adj', zh: '好的' },
  { word: 'gutaussehend', pos: 'adj', zh: '英俊的、漂亮的' },
  { word: 'gutgebaut', pos: 'adj', zh: '健壮的、结实的' },
  { word: 'Haus', pos: 'n', zh: '房子' },
  { word: 'hoch', pos: 'adv', zh: '高的' },
  { word: 'heute', pos: 'adv', zh: '今天' },
  { word: 'jung', pos: 'adj', zh: '年轻的' },
  { word: 'Kind', pos: 'n', zh: '孩子' },
  { word: 'kommen', pos: 'v', zh: '来' },
  { word: 'lang', pos: 'adj', zh: '长的' },
  { word: 'machen', pos: 'v', zh: '做' },
  { word: 'nicht', pos: 'adv', zh: '不' },
  { word: 'neu', pos: 'adj', zh: '新的' },
  { word: 'schön', pos: 'adj', zh: '漂亮的' },
  { word: 'sein', pos: 'v', zh: '是' },
  { word: 'Tag', pos: 'n', zh: '天' },
  { word: 'unglaublich', pos: 'adj', zh: '不可思议的' },
  { word: 'unvergessen', pos: 'adj', zh: '难忘的' },
  { word: 'viel', pos: 'adj', zh: '许多' },
  { word: 'vielbeachtet', pos: 'adj', zh: '备受关注的' },
  { word: 'und', pos: 'conj', zh: '和' },
  { word: 'Wasser', pos: 'n', zh: '水' },
  { word: 'weit', pos: 'adj', zh: '远的' },
  { word: 'Wort', pos: 'n', zh: '单词' },
  { word: 'zeigen', pos: 'v', zh: '展示' },
  { word: 'Zeit', pos: 'n', zh: '时间' }
]

/**
 * POS 缩写 → 中文标签映射。
 * 构建脚本已将完整英文词性名（noun/verb 等）归一化为缩写（n/v 等），
 * 此处只需映射缩写即可。
 * 若数据源直接传入未归一化的完整词性名，也会尝试匹配。
 */
const POS_LABELS = {
  // 标准缩写
  n: '名词',
  v: '动词',
  adj: '形容词',
  adv: '副词',
  prep: '介词',
  conj: '连词',
  pron: '代词',
  other: '其他'
}

/** 将文本中的德语变音字母降级为纯字母（ä→a, ö→o, ü→u），用于非变音 query 的模糊匹配 */
function toFuzzyTerm(searchTerm) {
  return searchTerm.replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
}

/** 当前使用的词库条目（运行时可变：加载后替换为 JSON 数据） */
let activeEntries = FALLBACK_DICTIONARY.map((e) => {
  const st = e.word.toLowerCase()
  return { search_term: st, fuzzy_term: toFuzzyTerm(st), word: e.word, pos: e.pos, brief: e.zh }
})

/** 是否已完成首层索引加载 */
let coreLoaded = false
/** 是否已完成完整索引加载 */
let fullLoaded = false

/** 首层索引加载 Promise（幂等） */
let coreLoadPromise = null
/** 完整索引加载 Promise（幂等） */
let fullLoadPromise = null

/** 加载前待处理的查询值（加载完成后立即重新搜索） */
let pendingQuery = ''
/** 是否已注册加载完成后的重新搜索回调 */
let retriggerCallback = null

/**
 * 注册加载完成后的重新搜索回调。
 * 由 german-events.js 在绑定事件后调用，避免词典模块直接依赖事件层。
 * @param {(query: string) => void} callback
 */
export function onDictionaryLoaded(callback) {
  retriggerCallback = callback
}

/**
 * 获取当前输入查询值（由事件层在调用 loadGermanDictionary 前注入）。
 * @returns {string}
 */
export function setPendingQuery(query) {
  pendingQuery = (query || '').trim()
}

/** 对文本做小写 + NFC 规范化，ß→ss 兼容 */
function normalizeQuery(value) {
  if (!value) return ''
  return value.normalize('NFC').trim().toLowerCase().replace(/ß/g, 'ss')
}

/**
 * 判断归一化后的查询是否含有德语变音字母（ä/ö/ü）。
 * 用于非对称模糊匹配：
 *   - 无变音 query（如 "haus"）→ 比较 fuzzy_term（降级的纯字母键），可同时命中变音词
 *   - 有变音 query（如 "häus"）→ 比较原始 search_term（含变音），只命中变音词
 */
function hasUmlaut(normalizedQuery) {
  return /[äöü]/.test(normalizedQuery)
}

/**
 * 解析复合词性字符串（如 "n/adj"）为中文标签。
 * 构建脚本产出的 pos 字段可能是 "n"、"adj" 或 "n/adj" 等。
 * 将 "/" 拆分后逐个查找，无法匹配的部分回退为原值。
 */
function resolvePosLabel(pos) {
  if (!pos) return ''
  // 先尝试直接查表（精确命中）
  if (POS_LABELS[pos]) return POS_LABELS[pos]
  // 复合词性：按 "/" 拆分后逐个映射，再用 "/" 连接
  const parts = pos.split('/')
  const labels = parts.map((p) => POS_LABELS[p.trim()] || p.trim())
  return labels.length > 1 ? labels.join('/') : labels[0]
}

/** 构建词性标签 */
function buildSuggestion(entry) {
  return {
    word: entry.word,
    pos: entry.pos,
    posLabel: resolvePosLabel(entry.pos),
    zh: entry.brief
  }
}

/**
 * 本地模糊匹配：精确匹配优先 → 前缀匹配 → 包含匹配。
 * 搜索全量 activeEntries，不因提前收集到足够候选而退出。
 *
 * 非对称变音模糊匹配（Umlaut fuzzy matching）：
 *   - 无变音 query（如 "haus"）：同时比较原始 search_term 和降级 fuzzy_term（ä→a, ö→o, ü→u），
 *     使得输入 "haus" 可以命中 "Haus"（精确）和 "Häuschen"（fuzzy 前缀）。
 *   - 有变音 query（如 "häus"）：只比较原始 search_term（含变音），
 *     使得输入 "häus" 只能命中 "Häuschen"，不能命中 "Haus"。
 * 同级结果按确定性的次级排序（search_term 字母序 + pos + word）保持稳定。
 * 去重展示词，保持大小写不敏感和 ß/ss 兼容。
 * @param {string} query — 用户输入
 * @param {number} limit — 最大返回条数
 * @returns {{word:string,pos:string,posLabel:string,zh:string}[]}
 */
export function searchLocalDictionary(query, limit = 8) {
  const q = normalizeQuery(query)
  if (!q) return []

  const umlautMode = hasUmlaut(q)

  const exactMatches = []
  const prefixMatches = []
  const includesMatches = []

  for (const entry of activeEntries) {
    const w = entry.search_term
    // 非变音模式下使用预计算的 fuzzy_term 做匹配；有变音模式只比较原始 search_term
    const fw = umlautMode ? '' : entry.fuzzy_term

    // 精确匹配：非变音模式下，原始 search_term 或 fuzzy_term 等于 q 都算精确
    if (w === q || (!umlautMode && fw === q)) {
      exactMatches.push(entry)
    // 前缀匹配：非变音模式下，原始 search_term 或 fuzzy_term 以 q 开头
    } else if (w.startsWith(q) || (!umlautMode && fw.startsWith(q))) {
      prefixMatches.push(entry)
    // 包含匹配：非变音模式下，原始 search_term 或 fuzzy_term 包含 q
    } else if (w.includes(q) || (!umlautMode && fw.includes(q))) {
      includesMatches.push(entry)
    }
  }

  // 对每组做确定性次级排序：search_term 字母序 → pos → word
  const secondarySort = (a, b) =>
    a.search_term.localeCompare(b.search_term) ||
    a.pos.localeCompare(b.pos) ||
    a.word.localeCompare(b.word)

  exactMatches.sort(secondarySort)
  prefixMatches.sort(secondarySort)
  includesMatches.sort(secondarySort)

  // 合并三组结果：精确 → 前缀 → 包含
  const combined = [...exactMatches, ...prefixMatches, ...includesMatches].slice(0, limit)

  // 展示词去重：同一 word 仅保留第一次出现（优先级最高的那条）
  const seen = new Set()
  return combined
    .filter((e) => {
      if (seen.has(e.word)) return false
      seen.add(e.word)
      return true
    })
    .map(buildSuggestion)
}

/**
 * 查找本地词库中是否有完全匹配（大小写不敏感）的词条。
 * @param {string} word
 * @returns {{word:string,pos:string,zh:string} | null}
 */
export function findLocalEntry(word) {
  const w = normalizeQuery(word)
  if (!w) return null
  const entry = activeEntries.find((e) => e.search_term === w) || null
  if (!entry) return null
  return { word: entry.word, pos: entry.pos, zh: entry.brief }
}

/** 获取当前词库条目数量（调试用） */
export function getDictionarySize() {
  return activeEntries.length
}

/** 获取当前加载状态（调试用） */
export function getDictionaryStatus() {
  return {
    coreLoaded,
    fullLoaded,
    entryCount: activeEntries.length
  }
}

/**
 * 加载静态分层 JSON 词库（幂等）。
 * 首层：index-core.json
 * 完整：index.json（按需，在首层完成后）
 *
 * 加载完成后：
 *   1. 替换 activeEntries 为完整索引（或首层索引）
 *   2. 若有 pendingQuery，通过 retriggerCallback 触发重新搜索
 *
 * 失败时保留兜底词库，不影响 LLM 直接查询流程。
 */
export function loadGermanDictionary() {
  // 首层加载（幂等）
  if (!coreLoadPromise) {
    coreLoadPromise = (async () => {
      const url = 'data/german/index-core.json'
      try {
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (!Array.isArray(data)) throw new Error('索引格式错误：非数组')

        activeEntries = data.map((e) => ({
          search_term: e.search_term,
          fuzzy_term: toFuzzyTerm(e.search_term),
          word: e.word,
          pos: e.pos,
          brief: e.brief
        }))
        coreLoaded = true
        DBG('german:dict:core-loaded', { count: activeEntries.length })

        // 首层完成后，立即尝试加载完整索引
        if (!fullLoadPromise) {
          fullLoadPromise = loadFullIndex()
        }

        // 加载完成，重新触发当前查询
        if (retriggerCallback && pendingQuery) {
          retriggerCallback(pendingQuery)
        }
      } catch (error) {
        coreLoaded = false
        DBG('german:dict:core-load-failed', String(error))
        // 保留兜底词库，完整索引仍可尝试加载
        if (!fullLoadPromise) {
          fullLoadPromise = loadFullIndex()
        }
      }
    })()
  }

  return coreLoadPromise
}

/** 加载完整索引（约 5 万条） */
function loadFullIndex() {
  fullLoadPromise = (async () => {
    const url = 'data/german/index.json'
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (!Array.isArray(data)) throw new Error('索引格式错误：非数组')

      activeEntries = data.map((e) => ({
        search_term: e.search_term,
        fuzzy_term: toFuzzyTerm(e.search_term),
        word: e.word,
        pos: e.pos,
        brief: e.brief
      }))
      fullLoaded = true
      DBG('german:dict:full-loaded', { count: activeEntries.length })

      // 完整索引加载完成，重新触发当前查询
      if (retriggerCallback && pendingQuery) {
        retriggerCallback(pendingQuery)
      }
    } catch (error) {
      fullLoaded = false
      DBG('german:dict:full-load-failed', String(error))
      // 保留首层索引（或兜底词库），不阻断使用
    }
  })()
  return fullLoadPromise
}

export { POS_LABELS }
export { FALLBACK_DICTIONARY as default }

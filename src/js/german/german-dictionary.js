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

/**
 * 解析静态数据 URL：自动适配部署路径。
 *
 * 核心策略（按优先级）：
 * 1. 优先使用 Vite 的 BASE_URL（import.meta.env.BASE_URL）。
 *    Vite 在 dev 与 build 阶段都会将其静态替换为 vite.config.js 里 base 的实际值：
 *      - dev（base: '/NJs_Workflow/'）→ '/NJs_Workflow/'
 *      - build（GitHub Pages）        → 同样的绝对前缀
 *    这是与"资源 URL 前缀"唯一权威、永远一致的来源。
 *
 * 2. 仅当 BASE_URL 为 undefined（手动全量复制 dist 后用浏览器原生打开、
 *    或非 Vite 环境下运行打包后的 JS 模块）才回退到 window.location 推导：
 *    - 二级路径（如 https://user.github.io/NJs_Workflow/）→ 取第一段路径作 base
 *    - 根路径（如 http://localhost:5173/）                → base = '/'
 *
 * 3. dev server 下的兜底校验：BASE_URL 拼接出的 URL 在 dev server 下不总是
 *    可命中（vite dev 对 base 前缀的处理在不同版本/配置下可能不一致）。
 *    因此 resolveDataUrl 仅作为"首选 URL"返回，loadGermanDictionary /
 *    loadFullIndex 会先用该 URL fetch；若 4xx/5xx 失败，再尝试
 *    window.location 推导出的备选 URL 重试一次（见 loadWithRetry）。
 *
 * 说明：
 * - 之所以用 BASE_URL 而非纯 window.location：window.location 的 hostname 判断
 *   无法感知 vite.config.js 的 base 前缀。当 dev server 也配置了
 *   base: '/NJs_Workflow/' 时，整个应用被挂载在 /NJs_Workflow/ 下，
 *   旧逻辑按 isLocalhost 直接拼出 /data/german/... 会丢掉前缀导致 404。
 *
 * 性能：URL 在同一会话中固定不变，缓存计算结果（relPath → url）。
 * loadGermanDictionary 与 loadFullIndex 各调用一次，避免重复推导。
 */
const _urlCache = new Map()

/** 计算基于 window.location 推导的 URL（手动打开 dist / 浏览器直连 场景的兜底） */
function resolveUrlViaLocation(clean) {
  if (typeof window === 'undefined' || !window.location) return '/' + clean
  const firstSeg = window.location.pathname.split('/').filter(Boolean)[0] || ''
  return firstSeg ? `/${firstSeg}/${clean}` : `/${clean}`
}

/** 读取 Vite 注入的 base 前缀；非 Vite 环境（原生浏览器打开 dist）时为 undefined */
function getViteBase() {
  try {
    return typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.BASE_URL
  } catch {
    return undefined
  }
}

/**
 * 返回 { primary, alternate }：
 * - primary: 首选 URL（优先 Vite BASE_URL；BASE_URL 缺失时用 window.location 推导）
 * - alternate: 另一个候选 URL（BASE_URL 缺失时为 null）
 * 同一 relPath 在同一会话中 URL 固定，缓存结果避免重复推导。
 */
function resolveDataUrl(relPath) {
  if (_urlCache.has(relPath)) return _urlCache.get(relPath)
  const clean = relPath.replace(/^\/+/, '')

  const base = getViteBase()
  if (base) {
    // BASE_URL 形如 '/NJs_Workflow/' 或 '/'，保证以 / 结尾再拼接相对路径
    const prefix = base.endsWith('/') ? base : base + '/'
    const primary = prefix + clean
    const alternate = resolveUrlViaLocation(clean)
    const result = { primary, alternate: alternate === primary ? null : alternate }
    _urlCache.set(relPath, result)
    DBG('german:dict:url', { relPath, primary, alternate: result.alternate, via: 'BASE_URL' })
    return result
  }

  // BASE_URL 缺失（手动打开 dist / 非 Vite 环境）：仅 window.location 推导
  const primary = resolveUrlViaLocation(clean)
  _urlCache.set(relPath, { primary, alternate: null })
  DBG('german:dict:url', { relPath, primary, via: 'window.location' })
  return { primary, alternate: null }
}

/**
 * 带兜底重试的 fetch：先用 primary URL；若 4xx/5xx 且存在 alternate，再用 alternate 重试一次。
 * 返回 res（由调用方判断 ok / 解析 json），永不 reject 4xx（交给调用方按 HTTP 状态码处理）。
 * 说明：仅针对 4xx/5xx 响应做重试（避免网络错误被吞掉后误判为"成功"）。
 */
async function fetchDataWithFallback(primary, alternate, relPath) {
  let res = await fetch(primary)
  if (res.status >= 400 && alternate) {
    DBG('german:dict:fetch-fallback', { relPath, primary, alternate, from: res.status })
    res = await fetch(alternate)
  }
  return res
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

/**
 * 前缀分桶索引：首字母 → 条目数组。
 * 搜索时只需遍历与 query 首字母匹配的桶（通常是几百~几千条），而非全量 125k 条。
 * 当 query 为空或首字母未知时回退到全量扫描（极少发生）。
 * 由 applyEntries 在词库加载时重建。
 */
let prefixBuckets = new Map()

/**
 * 重建前缀分桶索引（在 activeEntries 被替换后调用）。
 * 设计约束：桶按 search_term 首字符分组；fuzzy_term 共享同一桶（同一词形）。
 * 空首字符或首字符为 '\0'（NUL）的条目归入 '' 桶（极少，兜底）。
 */
function rebuildPrefixBuckets(entries) {
  prefixBuckets = new Map()
  for (const entry of entries) {
    const ch = entry.search_term.charAt(0) || ''
    if (!prefixBuckets.has(ch)) prefixBuckets.set(ch, [])
    prefixBuckets.get(ch).push(entry)
  }
}

/** 初始化时构建兜底词库的索引 */
rebuildPrefixBuckets(activeEntries)

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
 * 确定性次级排序比较器：search_term → pos → word。
 * 保留 localeCompare（Unicode 感知排序）以保证与优化前结果顺序完全一致。
 * 说明：排序仅作用于"匹配后"的少量候选（精确/前缀/包含三组合计通常 < 100 条），
 * 非全量 125k 条，localeCompare 开销可忽略。性能瓶颈在"匹配扫描"而非"排序"，
 * 已由前缀分桶索引解决。
 */
const secondarySort = (a, b) =>
  a.search_term.localeCompare(b.search_term) ||
  a.pos.localeCompare(b.pos) ||
  a.word.localeCompare(b.word)

/**
 * 本地模糊匹配：精确匹配优先 → 前缀匹配 → 包含匹配。
 * 性能优化（2026-09 重构）：
 *   - 精确/前缀匹配走前缀分桶索引（只遍历 query 首字母桶，通常几百~几千条），
 *     避免对 125k 条做全量精确/前缀扫描（核心瓶颈）
 *   - 包含匹配仍全量扫描（includes 可能命中 query 不在词首的条目，分桶不安全）
 *   - 排序保留 localeCompare（Unicode 感知），作用于匹配后少量候选，保证结果顺序与优化前一致
 *
 * 非对称变音模糊匹配（Umlaut fuzzy matching）：
 *   - 无变音 query（如 "haus"）：先比较原始 search_term，未命中再比较降级 fuzzy_term（ä→a, ö→o, ü→u），
 *     使得输入 "haus" 可以命中 "Haus"（精确）和 "Häuschen"（fuzzy 前缀）。
 *   - 有变音 query（如 "häus"）：只比较原始 search_term（含变音），
 *     使得输入 "häus" 只能命中 "Häuschen"，不能命中 "Haus"。
 * 同级结果按确定性的次级排序（search_term 码点序 + pos + word）保持稳定。
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

  // --- 第一遍：精确 + 前缀匹配（走分桶，只遍历 query 首字母桶） ---
  // 前缀分桶：只遍历与 query 首字母匹配的桶。桶不存在时回退全量（极少发生，兜底安全）。
  const firstCh = q.charAt(0)
  const bucketEntries = prefixBuckets.has(firstCh)
    ? prefixBuckets.get(firstCh)
    : activeEntries

  // 记录第一遍已匹配的 entry 引用，供第二遍快速跳过（O(1) 查找，避免 O(n·m) 的 includes）
  const matchedInFirstPass = new Set()

  for (const entry of bucketEntries) {
    const w = entry.search_term
    const fw = umlautMode ? '' : entry.fuzzy_term

    if (w === q || (!umlautMode && fw === q)) {
      exactMatches.push(entry)
      matchedInFirstPass.add(entry)
    } else if (w.startsWith(q) || (!umlautMode && fw.startsWith(q))) {
      prefixMatches.push(entry)
      matchedInFirstPass.add(entry)
    }
  }

  // --- 第二遍：包含匹配（全量扫描，includes 可能命中 query 不在词首的条目） ---
  // 同一 entry 不会既被归入精确/前缀又归入包含（语义与原实现一致），用 Set 快速跳过
  for (const entry of activeEntries) {
    if (matchedInFirstPass.has(entry)) continue
    const w = entry.search_term
    const fw = umlautMode ? '' : entry.fuzzy_term
    if (w.includes(q) || (!umlautMode && fw.includes(q))) {
      includesMatches.push(entry)
    }
  }

  // 对每组做确定性次级排序：search_term 码点序 → pos → word
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
      const { primary, alternate } = resolveDataUrl('data/german/index-core.json')
      try {
        const res = await fetchDataWithFallback(primary, alternate, 'data/german/index-core.json')
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
        rebuildPrefixBuckets(activeEntries)
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
    const { primary, alternate } = resolveDataUrl('data/german/index.json')
    try {
      const res = await fetchDataWithFallback(primary, alternate, 'data/german/index.json')
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
      rebuildPrefixBuckets(activeEntries)
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

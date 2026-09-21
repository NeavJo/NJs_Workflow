/**
 * german-llm.js — LLM 按需蒸馏 + LocalStorage 缓存
 * -----------------------------------------------------------------------------
 * 架构：
 *   1. 用户点击候选词 → 先查 LocalStorage 缓存（0ms）
 *   2. 缓存命中 → 直接返回结构化数据
 *   3. 缓存未命中 → 调用项目已有的 LLM 接口（复用 Anki 设置中的 API Key/模型）
 *      → 要求大模型以严格 JSON 返回词典数据
 *      → 解析 JSON → 写入缓存 → 返回
 *
 * LLM 返回的 JSON 格式约定：
 *   {
 *     "word": "Apfel",
 *     "ipa": "[ˈapfl̩]",
 *     "grammar": "der, Plural: Äpfel",
 *     "definitions": [
 *       {
 *         "index": 1,
 *         "tag": "Substantiv",
 *         "meaning": "苹果，一种圆形水果",
 *         "collocations": [],
 *         "example_de": "Ich esse jeden Tag einen Apfel.",
 *         "example_cn": "我每天吃一个苹果。"
 *       }
 *     ]
 *   }
 *
 * 缓存结构（LocalStorage key: njs-german-cache）：
 *   { "Apfel": { detail: {...}, ts: 1700000000000 }, ... }
 *   — 不设过期时间，用户可手动清空浏览器数据
 *
 * 错误处理：
 *   - 无 API Key → 返回 { ok:false, error:'no_credentials' }
 *   - LLM 调用失败 → 返回 { ok:false, error:'llm_failed', message:... }
 *   - JSON 解析失败 → 返回 { ok:false, error:'parse_failed', message:... }
 *   - 所有异常被捕获，永不 reject
 */

import { DBG } from '../core/debug.js'
import { safeStorageGet, safeStorageSet } from '../core/storage.js'
import { getAnkiSettings, hasAnkiCredentials } from '../anki/anki-store.js'
import { requestGemini, requestOpenAI } from '../anki/anki-api.js'

const CACHE_KEY = 'njs-german-cache'
const LLM_TIMEOUT_MS = 45000

/**
 * LLM 缓存容量上限（条数）。
 * 设计约束：
 * - LocalStorage 单 key 有 ~5MB 限制；每条 detail 含 2~5 条释义（中德双语例句），
 *   按平均 ~1KB/条估算，500 条 ≈ 0.5MB，留有充足余量。
 * - 超限时按 last-access 淘汰最旧条目（LRU 近似）：写入新条目时更新 ts，
 *   读取命中时也刷新 ts；淘汰时取 ts 最小的一条删除。
 * - 这是软上限：不阻断新写入，仅在 setCachedDetail 后若超出则裁剪。
 */
const CACHE_MAX_ENTRIES = 500

/**
 * 系统提示词：指令大模型以严格 JSON 返回德语词典数据。
 * 不包含用户输入的单词，userMessage 会单独传。
 */
const SYSTEM_PROMPT = `你是一个专业的德语词典助手。请为用户提供的德语单词返回严格 JSON 格式的词典数据。

返回格式（必须是合法 JSON，不要包含任何额外文字、markdown 标记或代码块）：
{
  "word": "单词原型（保留原始大小写）",
  "ipa": "国际音标，如 [ˈapfl̩]，无法确定则留空字符串",
  "grammar": "语法信息：词性（der/die/das）、复数形式、变格表、变位形式等，如 'der, Plural: Äpfel'",
  "definitions": [
    {
      "index": 1,
      "tag": "词性标注，如 Substantiv / Verb / Adjektiv / Adverb",
      "meaning": "中文释义",
      "collocations": [
        {
          "template": "sich freuen über + Akk.",
          "prepositions": ["über"]
        }
      ],
      "example_collocation_index": 0,
      "example_de": "德语例句（完整句子）。目标词的原型、变位形式、可分动词拆开的各部分或名词变格形式用花括号 {…} 包裹，例如 \"Ich {freue} mich <über> den Erfolg.\"；当前例句使用的固定介词用尖括号 <…> 包裹，且必须来自 collocations[example_collocation_index].prepositions。只包介词本身，不包冠词、宾语或 + Akk.",

      "example_cn": "例句中文翻译"
    }
  ]
}

规则：
1. 只返回 JSON 对象，不要任何额外文字
2. 释义至少 2 条，至多 5 条；排序不能只按字面义或词典传统顺序，必须按“真实使用频率 × 交际实用性”排序
3. 每条释义必须包含德语例句和中文翻译；例句必须能证明该释义或句型的实际用法
4. 例句中体现目标词的部分必须用花括号 {目标词} 包起来（如 {Apfel}）；动词变位、可分动词拆开的各部分、名词变格形式都要各自包裹；只包体现目标词的词，不要包整个句子
5. 名词必须标注 der/die/das 和复数形式
6. 动词必须标注关键变位形式（现在时第三人称单数、过去时、完成时）
7. 形容词必须标注比较级和最高级
8. 如果单词不存在或无法识别，返回 {"word":"","ipa":"","grammar":"","definitions":[]}

动词释义与高频句型优先级规则：
9. 查询结果是动词时，先识别该词在现代日常德语中最常出现、最值得学习的固定句型、功能结构和动介搭配，再组织释义；不能只从动词的字面本义（如“走、去”）开始罗列
10. 对动词按以下优先级生成释义：第一优先是高频固定句型或功能结构（包括无人称结构、代词结构和常用介词搭配）；第二优先是高频日常义；第三优先才是低频、书面、专业或字面延伸义。高频固定句型如果与字面义不同，必须单独作为核心释义项，不得埋在普通释义的例句里
11. 固定句型必须给出“句型整体的中文意义”，不能只翻译动词本身。例如 gehen 必须优先考虑并可单独生成“关于、涉及某事”的核心释义，句型为“es geht um + Akk.”，而不是只生成“走、去”；freuen 必须优先覆盖“sich freuen auf + Akk.”（期待）和“sich freuen über + Akk.”（为已经发生或拥有的事情感到高兴）等高频用法
12. 每个动词释义都要判断它是否对应一个独立的高频句型或搭配。若是，meaning、collocations、example_de、example_cn 必须围绕同一个句型生成；不得让中文释义说“涉及某事”，例句却使用“去某地”，也不得让搭配和例句表达无关意义
13. 对有多个常见义项的动词，优先保留学习价值最高的 2—5 个义项；可以合并明显同义的普通义，但不得为了凑数量加入罕见或脱离上下文的释义。固定句型和普通字面义属于不同用法时必须分开

动介搭配与例句绑定规则：
14. 如果当前释义是动词，collocations 列出该释义下最常用、最具代表性的固定动介搭配；搭配按该释义中的使用频率排序，每个释义优先列 1—3 个，不要罗列所有可能介词；非动词释义返回空数组 []
15. template 是可直接展示的完整搭配或句型模板（如 “es geht um + Akk.”、“sich freuen auf + Akk.”），必须保留必要的代词、无人称主语或反身结构；prepositions 仅含模板中实际固定介词的词形（如 ["um"] 或 ["auf"]）
16. example_collocation_index 必须是当前例句实际使用的搭配在 collocations 中的下标；如果没有搭配则固定为 0
17. example_de 必须先确定当前释义和 example_collocation_index 指定的搭配，再生成完整、自然、贴近日常场景的例句；例句必须同时满足：表达当前 meaning、使用指定句型、与中文翻译逐字对应。不能先生成一个普通例句再强行添加搭配标记
18. 例句中的目标词词形用 {…} 包裹，实际出现且属于所选搭配 prepositions 的介词用 <…> 包裹；例如“Es {geht} <um> die Kosten.”对应“关于费用/涉及费用”，不得写成与搭配无关的“Wir {gehen} nach Hause.”
19. <…> 只包介词本身，不包冠词、宾语、补语或 + Akk.；不得把与当前搭配无关的介词用尖括号包裹。若所选搭配没有在例句中实际出现，不得声称该例句使用了该搭配
20. 同一释义若有多个搭配，只能为 example_collocation_index 指定的一个搭配生成例句；其余搭配仅在 collocations 中展示。不同搭配表达不同中文意义时，应拆成不同释义项，不要用一个含糊释义覆盖它们
21. 标记符号不得嵌套；普通标点和其他句子部分不加标记
22. 返回内容必须仍是合法 JSON，不得输出 Markdown 或额外解释`

/**
 * 读取缓存中的词条详情（命中时刷新 ts，作为 LRU 触点的近似实现）。
 * 命中后写回 ts 不触发"超上限裁剪"——只更新单条时间戳，开销可忽略。
 * @param {string} word — 德语单词（原始大小写）
 * @returns {object|null} — 缓存命中返回 detail 对象，未命中返回 null
 */
export function getCachedDetail(word) {
  if (!word) return null
  const cache = safeStorageGet(CACHE_KEY, {})
  const entry = cache && cache[word]
  if (entry && entry.detail) {
    // LRU 触点：刷新时间戳使该条目成为"最近访问"，避免下次裁剪时被误淘汰
    entry.ts = Date.now()
    safeStorageSet(CACHE_KEY, cache)
    DBG('german:cache:hit', { word, ts: entry.ts })
    return normalizeDetail(entry.detail)
  }
  return null
}

/**
 * 写入缓存，并在超过 CACHE_MAX_ENTRIES 时按 ts 升序裁剪最旧条目（LRU 近似）。
 * 软上限：写入永远成功（除非 safeStorageSet 本身失败），仅多余条目被裁掉。
 * @param {string} word — 德语单词
 * @param {object} detail — 结构化词典数据
 */
export function setCachedDetail(word, detail) {
  if (!word || !detail) return
  const cache = safeStorageGet(CACHE_KEY, {})
  cache[word] = { detail, ts: Date.now() }

  // 裁剪超上限的旧条目（ts 最小的优先淘汰；新写入的 word 自身被保留）
  const keys = Object.keys(cache)
  if (keys.length > CACHE_MAX_ENTRIES) {
    const excess = keys.length - CACHE_MAX_ENTRIES
    const sorted = keys
      .filter((k) => k !== word) // 刚写入的条目不参与淘汰
      .sort((a, b) => (cache[a]?.ts || 0) - (cache[b]?.ts || 0))
    for (let i = 0; i < Math.min(excess, sorted.length); i++) {
      delete cache[sorted[i]]
    }
    DBG('german:cache:trim', { word, trimmed: sorted.length, kept: Object.keys(cache).length })
  }

  const ok = safeStorageSet(CACHE_KEY, cache)
  DBG('german:cache:set', { word, ok })
}

/**
 * 删除单个词条的缓存（供"重新蒸馏"或用户手动清理使用）。
 * 不存在的 key 返回 false（无副作用）。
 * @param {string} word — 德语单词
 * @returns {boolean} 是否实际删除了条目
 */
export function removeCachedDetail(word) {
  if (!word) return false
  const cache = safeStorageGet(CACHE_KEY, {})
  if (!(word in cache)) return false
  delete cache[word]
  const ok = safeStorageSet(CACHE_KEY, cache)
  DBG('german:cache:remove', { word, ok })
  return ok
}

/**
 * 清空全部德语助手缓存。
 */
export function clearGermanCache() {
  return safeStorageSet(CACHE_KEY, {})
}

/**
 * 通过 LLM 蒸馏单词详情。
 * 先查缓存，命中直接返回；未命中则调用 LLM 并缓存结果。
 *
 * @param {string} word — 要查询的德语单词
 * @param {{refetch?:boolean}} [options] — refetch=true 时跳过缓存，强制重新蒸馏（并更新缓存）
 * @returns {Promise<{ok:boolean, detail?:object, cached?:boolean, error?:string, message?:string}>}
 *   - ok:true  → detail 为结构化词典数据；cached:true 表示来自缓存
 *   - ok:false → error 为错误类型标识，message 为可展示文案
 */
export async function lookupWordViaLLM(word, options) {
  const w = (word || '').trim()
  if (!w) {
    return { ok: false, error: 'empty', message: '单词为空' }
  }

  // 1. 查缓存（refetch=true 时跳过缓存，强制重新蒸馏并刷新缓存）
  if (!options || !options.refetch) {
    const cached = getCachedDetail(w)
    if (cached) {
      return { ok: true, detail: cached, cached: true }
    }
  }

  // 2. 检查 LLM 凭证
  if (!hasAnkiCredentials()) {
    DBG('german:llm:no-credentials')
    return { ok: false, error: 'no_credentials', message: '请先在「设置」中配置 AI API Key 与模型。' }
  }

  const settings = getAnkiSettings()
  DBG('german:llm:request', { word: w, apiType: settings.apiType, modelId: settings.modelId })

  // 3. 调用 LLM
  let result
  try {
    result = settings.apiType === 'openai'
      ? await requestOpenAI({
          baseUrl: settings.baseUrl,
          modelId: settings.modelId,
          apiKey: settings.apiKey,
          systemPrompt: SYSTEM_PROMPT,
          userMessage: w
        })
      : await requestGemini({
          baseUrl: settings.baseUrl,
          modelId: settings.modelId,
          apiKey: settings.apiKey,
          systemPrompt: SYSTEM_PROMPT,
          userMessage: w
        })
  } catch (err) {
    DBG('german:llm:exception', String(err))
    return { ok: false, error: 'llm_exception', message: 'LLM 调用异常，请稍后重试。' }
  }

  if (!result.ok) {
    DBG('german:llm:failed', { status: result.status, error: result.error })
    return { ok: false, error: 'llm_failed', message: result.error || 'LLM 调用失败，请稍后重试。' }
  }

  // 4. 解析 JSON
  const detail = parseLLMResponse(result.text)
  if (!detail) {
    DBG('german:llm:parse-failed', { textLength: result.text.length, preview: result.text.slice(0, 200) })
    return { ok: false, error: 'parse_failed', message: 'LLM 返回数据解析失败，请重试。' }
  }

  // 5. 写入缓存
  setCachedDetail(w, detail)

  DBG('german:llm:done', { word: w, definitions: detail.definitions?.length || 0 })
  return { ok: true, detail, cached: false }
}

/**
 * 从 LLM 返回的文本中提取 JSON 并校验。
 * 兼容模型偶尔在 JSON 外包裹 ```json ... ``` 的情况。
 *
 * @param {string} text — LLM 返回的原始文本
 * @returns {object|null} — 合法则返回 detail 对象，否则 null
 */
function parseLLMResponse(text) {
  if (!text || typeof text !== 'string') return null

  // 尝试直接 parse
  let parsed = tryParseJSON(text)
  if (!parsed) {
    // 尝试提取 ```json ... ``` 内的内容
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenced) {
      parsed = tryParseJSON(fenced[1])
    }
  }
  if (!parsed) {
    // 尝试提取第一个 { 到最后一个 } 的子串
    const first = text.indexOf('{')
    const last = text.lastIndexOf('}')
    if (first >= 0 && last > first) {
      parsed = tryParseJSON(text.slice(first, last + 1))
    }
  }

  if (!parsed) return null

  // 结构校验：至少要有 word 和 definitions
  if (!parsed || typeof parsed !== 'object') return null
  if (!Array.isArray(parsed.definitions)) return null

  // 规范化字段
  return normalizeDetail(parsed)
}

function tryParseJSON(str) {
  try {
    return JSON.parse(str)
  } catch {
    return null
  }
}

/**
 * 规范化 LLM 返回的 detail，确保字段齐全。
 * 缺失字段填充空字符串/空数组，保证渲染层不 crash。
 */
function normalizeDetail(raw) {
  const definitions = (raw.definitions || []).map((d, i) => ({
    index: d.index || i + 1,
    tag: String(d.tag || ''),
    meaning: String(d.meaning || ''),
    collocations: normalizeCollocations(d.collocations),
    example_collocation_index: Number.isInteger(d.example_collocation_index) && d.example_collocation_index >= 0
      ? d.example_collocation_index
      : 0,
    example_de: String(d.example_de || ''),
    example_cn: String(d.example_cn || '')
  })).filter((d) => d.meaning || d.example_de)

  return {
    word: String(raw.word || ''),
    ipa: String(raw.ipa || raw.phonetic || ''),
    grammar: String(raw.grammar || raw.inflection || ''),
    definitions,
    source: String(raw.source || 'AI')
  }
}

/**
 * 规范化 collocations 数组，兼容旧缓存和异常输入。
 * 每个条目仅保留合法 template 字符串和非空 prepositions 数组。
 */
function normalizeCollocations(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((c) => c && typeof c === 'object')
    .map((c) => {
      const template = String(c.template || '')
      const prepositions = Array.isArray(c.prepositions)
        ? c.prepositions.filter((p) => typeof p === 'string' && p.length > 0)
        : []
      if (!template || prepositions.length === 0) return null
      return { template, prepositions }
    })
    .filter(Boolean)
}

export { CACHE_KEY, LLM_TIMEOUT_MS, CACHE_MAX_ENTRIES }

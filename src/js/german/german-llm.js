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
  "grammar": "语法信息：词性、复数、变格或变位等",
  "definitions": [
    {
      "index": 1,
      "tag": "词性标注，如 Substantiv / Verb / Adjektiv / Adverb",
      "meaning": "中文释义",
      "collocations": [
        {
          "template": "完整固定句型或动介搭配 + 格",
          "prepositions": ["介词"]
        }
      ],
      "example_collocation_index": 0,
      "example_de": "德语例句（完整句子）；标记规则见下方规则 8",
      "example_cn": "与德语例句对应的中文翻译"
    }
  ]
}

规则：
1. 只返回合法 JSON 对象，不要额外文字、Markdown 或代码块；无法识别时返回 {"word":"","ipa":"","grammar":"","definitions":[]}。
2. 释义生成 2—5 条，按“现代日常使用频率 × 学习实用性”排序；每条都必须有准确的中文释义、自然德语例句和对应中文翻译。不要为了凑数加入罕见义。
3. 名词在 grammar 中标注冠词和复数；动词标注现在时第三人称单数、过去时、完成时；形容词标注比较级和最高级。
4. 动词先提取当前词在现代日常德语中最高频、最实用的固定句型、功能结构和动介搭配，再生成普通日常义，最后才考虑低频、书面、专业或纯字面义；无人称、代词、反身和可分动词结构都要考虑。固定句型若表达独立意义，必须单独成义项；不得套用其他动词的搭配或例句。
5. 每个义项的 meaning、collocations、example_de、example_cn 必须表达同一个用法；不同搭配若表达不同中文意义，拆成不同义项。固定句型的 meaning 翻译完整结构，不要只翻译动词。
6. 动词义项的 collocations 只列该义项真实存在、最常用且最有代表性的 1—3 个搭配；不确定或不存在的搭配不要臆造，非动词返回 []。template 保留完整句型结构，prepositions 只填实际固定介词本身。
7. 先确定 meaning 和 example_collocation_index 指向的搭配，再生成贴近日常场景的例句；例句必须实际使用该搭配，并与 example_cn 对应，不得先写普通例句后强行添加标记。没有搭配时 index 固定为 0。
8. 目标词及其变位、可分部分或变格形式用 {…} 标记；当前例句实际使用且属于所选搭配的介词用 <…> 标记。只包介词本身，不包冠词、宾语、补语或 + Akk.；标记不得嵌套，其他介词不得使用 <…>。`

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

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
      "example_de": "德语例句（完整句子）",
      "example_cn": "例句中文翻译"
    }
  ]
}

规则：
1. 只返回 JSON 对象，不要任何额外文字
2. 释义至少 2 条，至多 5 条，按常用度排序
3. 每条释义必须包含德语例句和中文翻译
4. 名词必须标注 der/die/das 和复数形式
5. 动词必须标注关键变位形式（现在时第三人称单数、过去时、完成时）
6. 形容词必须标注比较级和最高级
7. 如果单词不存在或无法识别，返回 {"word":"","ipa":"","grammar":"","definitions":[]}`

/**
 * 读取缓存中的词条详情。
 * @param {string} word — 德语单词（原始大小写）
 * @returns {object|null} — 缓存命中返回 detail 对象，未命中返回 null
 */
export function getCachedDetail(word) {
  if (!word) return null
  const cache = safeStorageGet(CACHE_KEY, {})
  const entry = cache && cache[word]
  if (entry && entry.detail) {
    DBG('german:cache:hit', { word, ts: entry.ts })
    return entry.detail
  }
  return null
}

/**
 * 写入缓存。
 * @param {string} word — 德语单词
 * @param {object} detail — 结构化词典数据
 */
export function setCachedDetail(word, detail) {
  if (!word || !detail) return
  const cache = safeStorageGet(CACHE_KEY, {})
  cache[word] = { detail, ts: Date.now() }
  const ok = safeStorageSet(CACHE_KEY, cache)
  DBG('german:cache:set', { word, ok })
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
 * @returns {Promise<{ok:boolean, detail?:object, cached?:boolean, error?:string, message?:string}>}
 *   - ok:true  → detail 为结构化词典数据；cached:true 表示来自缓存
 *   - ok:false → error 为错误类型标识，message 为可展示文案
 */
export async function lookupWordViaLLM(word) {
  const w = (word || '').trim()
  if (!w) {
    return { ok: false, error: 'empty', message: '单词为空' }
  }

  // 1. 查缓存
  const cached = getCachedDetail(w)
  if (cached) {
    return { ok: true, detail: cached, cached: true }
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
    example_de: String(d.example_de || d.example_de || ''),
    example_cn: String(d.example_cn || d.example_cn || '')
  })).filter((d) => d.meaning || d.example_de)

  return {
    word: String(raw.word || ''),
    ipa: String(raw.ipa || raw.phonetic || ''),
    grammar: String(raw.grammar || raw.inflection || ''),
    definitions,
    source: 'AI'
  }
}

export { CACHE_KEY, LLM_TIMEOUT_MS }

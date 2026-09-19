#!/usr/bin/env node
/**
 * build-german-dictionary.mjs — 德语助手静态候选词库离线构建脚本
 * -----------------------------------------------------------------------------
 * 用途：
 *   从 Kaikki / Wiktionary 德语数据源构建浏览器可用的轻量 JSON 索引。
 *
 * 用法：
 *   node scripts/build-german-dictionary.mjs --url <数据URL> [--output public/data/german]
 *   node scripts/build-german-dictionary.mjs --input <本地文件> [--output public/data/german]
 *
 * 说明：
 *   - 默认数据源使用 Kaikki 德语词条页。
 *   - 支持直接读取本地 JSON / JSONL，便于离线生成与回归测试。
 *   - 输出仅包含 search_term / word / pos / brief 四个字段。
 *   - 校验失败时不写盘，避免生成不满足目标数量的半成品索引。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import zlib from 'node:zlib'
import readline from 'node:readline'

const DEFAULT_URL = 'https://kaikki.org/dictionary/German/index.html'
const DEFAULT_OUTPUT_DIR = 'public/data/german'
const CORE_TARGET = 5000
const FULL_TARGET = 50000
const MAX_BRIEF_LENGTH = 96
const MAX_WORD_LENGTH = 20

const DEFAULT_URL_RE = /kaikki\.org\/dictionary\/German\/index\.html$/i
const SUPPORTED_POS = new Set(['n', 'v', 'adj', 'adv', 'prep', 'conj', 'pron', 'other'])

/**
 * 完整英文词性名 → 缩写映射。
 * Kaikki / Wiktionary 数据中 pos 字段可能是缩写（"noun" 的缩写 "n"）
 * 也可能是完整英文词性名（"noun", "verb", "adjective" 等）。
 * 本映射将完整形式归一化为 SUPPORTED_POS 中的缩写。
 */
const POS_MAPPING = {
  noun: 'n',
  name: 'n',
  verb: 'v',
  adjective: 'adj',
  adverb: 'adv',
  preposition: 'prep',
  conjunction: 'conj',
  pronoun: 'pron',
  numeral: 'other',
  num: 'other',
  article: 'other',
  determinant: 'other',
  det: 'other',
  interjection: 'other',
  intj: 'other',
  phrase: 'other',
  contraction: 'other',
  character: 'other',
  symbol: 'other',
  particle: 'other',
  postp: 'other',
  interfix: 'other',
  circumfix: 'other',
  circumpos: 'other',
  infix: 'other',
  suffix: 'other',
  prefix: 'other',
  proverb: 'other',
  punct: 'other'
}

// 中文词性标签：核心词缺少 glosses/raw_glosses 时作为可读释义兜底
const POS_LABELS = {
  n: '名词',
  v: '动词',
  adj: '形容词',
  adv: '副词',
  prep: '介词',
  conj: '连词',
  pron: '代词',
  other: '其他'
}

// 核心词集合：构建完成时必须尽可能出现在 index-core.json 中且 brief 非空
const CORE_WORDS = new Set(['Haus', 'Apfel', 'sein', 'haben', 'Kombination', 'Drei'])

// 核心词固定兜底释义：只在 Kaikki 缺少 glosses/raw_glosses/translations 时使用
// 避免从模板、词形、音频、词源等不可读字段提取释义
const CORE_BRIEF_FALLBACKS = new Map([
  ['Haus', '房子'],
  ['Apfel', '苹果'],
  ['sein', '是；所有格（他的/它的）'],
  ['haben', '有；拥有'],
  ['Kombination', '组合；结合'],
  ['Drei', '三；数字 3']
])

// 核心词兜底词性：仅作为首层索引保证项使用，完整索引仍优先采用数据源词性
const CORE_POS_FALLBACKS = new Map([
  ['Haus', 'n'],
  ['Apfel', 'n'],
  ['sein', 'v'],
  ['haben', 'v'],
  ['Kombination', 'n'],
  ['Drei', 'other']
])

const USAGE = `Usage:
  node scripts/build-german-dictionary.mjs --url <Kaikki|Wiktionary JSON|JSONL URL> [--output <dir>]
  node scripts/build-german-dictionary.mjs --input <local-file> [--output <dir>]

Options:
  --url <url>             下载 Kaikki/Wiktionary 德语数据源
  --input <path>          直接读取本地 JSON / JSONL 文件
  --output <dir>          输出目录，默认 ${DEFAULT_OUTPUT_DIR}
  --max-core <n>          高频首层索引上限，默认 ${CORE_TARGET}
  --max-full <n>          完整索引上限，默认 ${FULL_TARGET}
  --allow-under-target    允许实际数据低于目标数量时仍然生成索引
  --help                  显示帮助
`

function fail(message) {
  console.error(`[build-german-dictionary] ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--help') {
      args.help = true
    } else if (token === '--allow-under-target') {
      args.allowUnderTarget = true
    } else if (token.startsWith('--')) {
      const key = token.slice(2)
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) fail(`${key} 需要参数值。`)
      args[key] = value
      i += 1
    }
  }
  return args
}

function normalizeTerm(value) {
  if (!value) return ''
  return String(value).normalize('NFC').trim()
}

function normalizeSearchTerm(value) {
  const raw = normalizeTerm(value)
  if (!raw) return ''
  // ß 同时兼容搜索 ss，但展示词条仍保留原始拼写。
  return raw.toLowerCase().replace(/ß/g, 'ss')
}

function cleanBrief(rawBrief) {
  if (!rawBrief) return ''
  let text = String(rawBrief)
  // 删除闭合的 Wiktionary 模板标记 {{...}}
  text = text.replace(/\{\{[^{}]*\}\}/g, ' ')
  // 删除未闭合的模板残留：从最后一个 {{ 到文本末尾
  // （源数据中偶有 {{gloss|...]] 这类未闭合模板，必须整体截断，否则残留 {{ 会被污染检测拦截）
  const lastTemplateOpen = text.lastIndexOf('{{')
  if (lastTemplateOpen !== -1) {
    text = text.slice(0, lastTemplateOpen)
  }
  // 删除未匹配的 Wiki markup 双花括号/双括号残留
  text = text.replace(/\]\]/g, ' ')
  text = text.replace(/\[\[/g, ' ')
  // 删除方括号链接、脚注标记 [1]、[note] 等
  text = text.replace(/\[[^\]]*\]/g, ' ')
  // 删除圆括号内容（通常包含词性标注等元数据）
  text = text.replace(/\([^)]*\)/g, ' ')
  // 删除 HTML 标签
  // 删除 HTML 标签（闭合和未闭合残留）
  text = text.replace(/<\/?[\w]+[^>]*>/g, ' ')
  text = text.replace(/<[^>]+>/g, ' ')
  // 删除 HTML 实体
  text = text.replace(/&#?\w+;/g, ' ')
  // 删除 Wiktionary 模板展开后的元数据字符串
  text = text.replace(/\bhead\b\s*de[^ ;，,。]{0,20}/g, ' ')
  text = text.replace(/\badj\s*de-adj\b/g, ' ')
  text = text.replace(/\bnum\s*head\s*de\b/g, ' ')
  // 删除调试/模板字符串
  text = text.replace(/\bwiktionary\b/gi, ' ')
  text = text.replace(/\btemplate\b/gi, ' ')
  // 删除 Markdown 格式字符
  text = text.replace(/[*_#`|~^]/g, ' ')
  // 合并多余空白并去首尾
  text = text.replace(/\s+/g, ' ').trim()
  // 清洗后为空（如全是模板标记）→ 返回空
  if (!text) return ''
  if (text.length <= MAX_BRIEF_LENGTH) return text
  return `${text.slice(0, Math.max(0, MAX_BRIEF_LENGTH - 1)).trimEnd()}…`
}

/**
 * 判断词条是否符合德语规范原形约束。
 * 过滤规则：
 *   1. 空值 → 丢弃
 *   2. 长度超过 MAX_WORD_LENGTH（20）→ 丢弃（异常超长复合词）
 *   3. 以 - 开头或结尾（词缀形态）→ 丢弃
 *   4. 仅由数字、标点、符号组成，无任何字母 → 丢弃
 *   5. 包含非法字符（超出德语字母 + 合法撇号 + 内部连字符）→ 丢弃
 * 正常保留：含德语字母（含 ä/ö/ü）、合法撇号、内部连字符的词条。
 */
function isGermanSearchable(word) {
  const raw = normalizeTerm(word)
  if (!raw) return false

  // 长度上限：不得因为存在释义而绕过
  if (raw.length > MAX_WORD_LENGTH) return false

  // 词缀边界：以连字符开头或结尾的形态（如 -augert、hausen-）丢弃
  if (raw.startsWith('-') || raw.endsWith('-')) return false

  // 提取字母部分（仅保留标准拉丁字母 + 德语变音字母）
  const letters = raw.replace(/[^A-Za-z\u00C0-\u00FF\u0100-\u017F\u00DF]/g, '')
  // 必须包含至少 2 个有效字母：过滤 'n、'ne、'nein 等德语缩写/连字符碎片噪声
  if (letters.length < 2) return false

  // 合法字符白名单：Unicode 字母、组合标记、撇号（' '）、连字符
  // 使用 RegExp 构造函数避免源文件编码破坏 Unicode 字符（'）
  const GERMAN_CHAR_RE = new RegExp("^[\\p{L}\\p{M}'\\u2019\\-]+$", 'u')
  if (!GERMAN_CHAR_RE.test(raw)) return false

  return true
}

function filterGermanEntries(record) {
  if (!record || typeof record !== 'object') return false
  const word = normalizeTerm(record.word || record.lemma || record.title || '')
  const lang = record.lang || record.language || record.lang_code || ''
  if (!isGermanSearchable(word)) return false
  // 支持德语语言标识：de / German / Deutsch（兼容大小写与常见变体）
  if (lang && !/de\b|\bdeutsch\b|\bgerman/i.test(lang)) return false
  return true
}

/**
 * 从 Kaikki 记录的 senses 数组提取结构化释义。
 * 优先级：senses[].glosses → senses[].raw_glosses（仅清洗后的有效文本）。
 * 禁止从 head_templates、forms、sounds、etymology 等元数据提取。
 * 返回合并去重后的可读 brief 字符串。
 */
function extractBrief(record, pos, word) {
  if (!record || typeof record !== 'object') return ''

  // Kaikki 数据中 senses 可能在 record.senses 或 record.part_of_speech.senses
  const senses = record.senses || (record.part_of_speech && record.part_of_speech.senses) || []
  if (!Array.isArray(senses) || !senses.length) return ''

  const briefs = []
  const seen = new Set()

  for (const sense of senses) {
    if (!sense || typeof sense !== 'object') continue

    // 优先提取 glosses 数组
    let extracted = ''
    if (Array.isArray(sense.glosses) && sense.glosses.length) {
      const items = sense.glosses.map((g) => cleanBrief(typeof g === 'string' ? g : JSON.stringify(g))).filter(Boolean)
      extracted = items.join('；')
    }

    // 回退到 raw_glosses
    if (!extracted && Array.isArray(sense.raw_glosses) && sense.raw_glosses.length) {
      const items = sense.raw_glosses.map((g) => cleanBrief(typeof g === 'string' ? g : JSON.stringify(g))).filter(Boolean)
      extracted = items.join('；')
    }

    if (extracted) {
      const cleaned = cleanBrief(extracted)
      if (cleaned && !seen.has(cleaned)) {
        seen.add(cleaned)
        briefs.push(cleaned)
      }
    }
  }

  if (!briefs.length) {
    // 核心词兜底：源数据没有 glosses/raw_glosses 时，优先中文翻译目标；
    // 仍为空时使用固定中文释义，保证高频核心词可读且绝不使用模板元数据。
    if (CORE_WORDS.has(word)) {
      const target = extractTargetFromTranslations(record, word)
      if (target) {
        briefs.push(target)
      } else {
        const fallbackBrief = CORE_BRIEF_FALLBACKS.get(word)
        if (fallbackBrief) briefs.push(fallbackBrief)
      }
    }
    if (!briefs.length) return ''
  }
  return normalizeBrief(briefs.join('；'))
}

function extractTargetFromTranslations(record, word) {
  if (!record || typeof record !== 'object') return ''
  const translations = record.translations
  if (!Array.isArray(translations)) return ''

  for (const translation of translations) {
    if (!translation || typeof translation !== 'object') continue
    // 仅接受中文目标词，避免把德语/英语互译噪声写进候选框
    if (translation.code !== 'zh' && translation.target_lang !== 'zh') continue
    const items = Array.isArray(translation.targets)
      ? translation.targets
      : Array.isArray(translation.target)
        ? [translation.target]
        : []
    const cleaned = items.map((item) => cleanBrief(typeof item === 'string' ? item : JSON.stringify(item))).filter(Boolean)
    if (cleaned.length) return cleanBrief(cleaned.join('、'))
  }
  return ''
}

function normalizeBrief(brief) {
  let value = String(brief || '').replace(/[\r\n]+/g, ' ').trim()
  value = value.replace(/\s{2,}/g, ' ')
  value = value.replace(/\s*；\s*/g, '；').replace(/\s*,\s*/g, '、')
  value = value.replace(/^[；、，,\s]+|[；、，,\s]+$/g, '')
  value = value.replace(/(；|、){2,}/g, '$1')
  return cleanBrief(value)
}

function normalizePos(pos) {
  const value = normalizeTerm(pos).toLowerCase()
  if (!value) return ''
  if (SUPPORTED_POS.has(value)) return value
  // 先尝试完整词性名称映射（如 "noun" → "n", "verb" → "v"）
  const mapped = POS_MAPPING[value]
  if (mapped) return mapped
  const firstPart = value.split(/[\/;，,|]/)[0].trim()
  if (SUPPORTED_POS.has(firstPart)) return firstPart
  const firstMapped = POS_MAPPING[firstPart]
  if (firstMapped) return firstMapped
  return 'other'
}

/**
 * 判断一条释义是否是"语法变体/屈折形式"的描述。
 * 德语 Wiktionary/Kaikki 中，非原型词条（如名词复数、形容词屈折、动词过去分词）
 * 的 glosses 通常明确写着 "inflection of ..."、"past participle of ..."、
 * "nominative/accusative plural of ..." 等。
 * 这类条目不应进入词典索引，避免搜索候选框被大量变体占用。
 */
function isInflectionGloss(gloss) {
  if (!gloss) return false
  const text = String(gloss).toLowerCase()
  // 1. 明确以 "inflection of" 开头（形容词/名词/动词屈折形式）
  if (text.startsWith('inflection of')) return true
  // 2. 过去分词："past participle of X"
  if (/^past participle of\b/.test(text)) return true
  // 3. 名词复数/变格："nominative/accusative plural of X"、"plural of X"、"genitive plural of X"
  if (/\bplural of\b/.test(text) && /\b(nominative|accusative|genitive|dative)\b/.test(text)) return true
  // 4. 名词复数简写："plural of X"（如 "plural of Häuschen"）
  if (/^plural of\b/.test(text)) return true
  // 5. 形容词屈折特征词组合："strong/weak/mixed" + 格/数标记
  if (/\b(strong|weak|mixed)\b/.test(text) && /\b(nominative|accusative|dative|genitive|singular|plural)\b/.test(text)) return true
  // 6. "dative masculine/neuter singular of X" 等带格的非原型描述
  if (/\b(nominative|accusative|dative|genitive)\b.*\b(masculine|feminine|neuter|all-gender)\b.*\b(singular|plural)\b.*\bof\b/.test(text)) return true
  // 7. 单数变格形式："genitive singular of X"、"dative singular of X"
  //    （名词的格变化，如 "genitive singular of Angebot"）
  if (/\b(genitive|dative|nominative|accusative)\b.*\bsingular of\b/.test(text)) return true
  // 8. 以格词 + plural of 开头的复数变格形式
  //    如 "nominative/accusative/genitive plural of X"、"plural of X"
  //    注意：只匹配以格词或 "plural" 开头的文本，避免误过滤正常释义
  if (/^(nominative|accusative|genitive|dative|plural)\b.*\bplural of\b/.test(text)) return true
  // 9. 纯格+数描述（无 "of X"），如 "dative singular"、"nominative/genitive/accusative plural"
  //    这类 gloss 本身是变体说明的一部分（常与 "inflection of X:" 配对出现），
  //    不包含独立释义，应视为变体标记
  // 匹配纯格词+数词组合（如 "dative singular"、"nominative plural"、"accusative/genitive plural"）
  const PURE_CASE_NUM_RE = /^((nominative|accusative|dative|genitive)(\/(nominative|accusative|dative|genitive))*)\s*(singular|plural)$/
  if (PURE_CASE_NUM_RE.test(text)) return true
  if (/^(singular|plural)$/.test(text)) return true
  // 10. 动词变位：带人称/数/语气的完整描述
  //     "first-person singular dependent present"、"second/third-person singular dependent subjunctive I" 等
  //     特征：同时含人称（first/second/third-person）+ 时态/语气（present/subjunctive/imperative 等）
  const PERSON_RE = /\b(first|second|third)-person\b|\bperson\b/
  const TENSE_MOOD_RE = /\b(present|past|imperfect|perfect|pluperfect|subjunctive|imperative|conditional)\b/
  if (PERSON_RE.test(text) && TENSE_MOOD_RE.test(text)) return true
  // 11. 分词变体：现在分词/过去分词/完成分词 等
  //     "present participle of X"、"past participle of X"、"perfect participle of X"
  //     特征：以 "X participle of" 开头
  if (/^(present|past|perfect|preterite|imperfect|conditional)\s+participle of\b/.test(text)) return true
  // 12. 动词变位：带 "of X" 的词尾变体，如 "second-person singular dependent subjunctive I of losgehen"
  //     特征：以 "X-person" 或 "X/X-person" 开头且含 " of "（非 "inflection of"，已被规则 1 捕获）
  if (/^((first|second|third|first\/third)-person\b.*\bof\b)/.test(text)) return true
  // 13. 形容词变格：比较级形式 "comparative degree of X"
  if (/^comparative degree of\b/.test(text)) return true
  // 14. 形容词变格："strong/weak/mixed nominative..." 开头且含格/性描述
  //     匹配 "strong/mixed nominative/accusative feminine singular" 等模式
  if (/^(strong|weak|mixed|strong\/mixed|strong\/weak|weak\/mixed|strong\/weak\/mixed)\s/.test(text) &&
      /\b(nominative|accusative|dative|genitive|masculine|feminine|neuter|all-gender|singular|plural|degree)\b/.test(text)) {
    return true
  }
  return false
}

/**
 * 判断一条 Kaikki 记录是否应被跳过（语法变体/屈折形式）。
 * 使用两层检测策略：
 *   1. 结构检测：检查 senses[].tags 中是否包含 "form-of" 标记
 *      （Kaikki 数据源对纯变体条目会添加 "form-of" tag）
 *   2. 语义检测：检查 glosses 是否全部为变体描述（"inflection of ..."、"past participle of ..." 等）
 * 只要命中任一层，且该记录没有有效的非变体释义，就判定为非原型词条并跳过。
 */
function isInflectionForm(record) {
  if (!record || typeof record !== 'object') return false
  const senses = record.senses || (record.part_of_speech && record.part_of_speech.senses) || []
  if (!Array.isArray(senses) || !senses.length) return false

  let hasInflectionMarker = false
  let hasRealGloss = false

  for (const sense of senses) {
    if (!sense || typeof sense !== 'object') continue

    // 结构检测：tags 中包含 "form-of" 说明该 sense 是纯变体
    if (Array.isArray(sense.tags) && sense.tags.includes('form-of')) {
      hasInflectionMarker = true
    }

    const glosses = Array.isArray(sense.glosses) ? sense.glosses : []
    const rawGlosses = Array.isArray(sense.raw_glosses) ? sense.raw_glosses : []
    const allGlosses = [...glosses, ...rawGlosses]

    for (const g of allGlosses) {
      const text = typeof g === 'string' ? g : JSON.stringify(g)
      if (isInflectionGloss(text)) {
        hasInflectionMarker = true
      } else {
        // 非空且非纯变体的 gloss 视为有效释义
        const cleaned = cleanBrief(text)
        if (cleaned) {
          hasRealGloss = true
        }
      }
    }
  }

  // 只有存在变体标记、且没有任何有效释义时才跳过
  return hasInflectionMarker && !hasRealGloss
}

function buildRecord(record) {
  if (!record || typeof record !== 'object') return []

  const word = normalizeTerm(record.word || record.lemma || record.title || '')
  if (!word || !isGermanSearchable(word)) return []

  const pos = normalizePos(record.pos || record.part_of_speech || 'other')
  if (!pos) return []

  // 跳过纯语法变体/屈折形式条目（名词复数、动词过去分词、形容词屈格变体等）
  // 设计约束：isInflectionForm 对 pos=adj 条目采用"有真实释义才保留"策略——
  // 独立复合形容词（如 gutaussehend, selbstbewusst）gloss 为真实释义，不含 inflection/participle 标记，保留；
  // 形容词屈格变体（如 wilde, deutscher）gloss 全部为 "inflection of X:" 或 "strong/mixed nominative..."，过滤。
  if (isInflectionForm(record)) return []

  const search_term = normalizeSearchTerm(word)
  if (!search_term) return []

  const brief = extractBrief(record, pos, word)
  if (!brief) return []

  return [{ search_term, word, pos, brief }]
}

function recordFrequency(record) {
  if (!record || typeof record !== 'object') return 0
  const candidates = [record.frequency, record.freq, record.count, record.usage_count, record.popularity, record.wikidata_freq]
  for (const value of candidates) {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return 0
}

/**
 * 核心词 word 规范化：如果 entry 的 word 或 word 首字母大写形式
 * 匹配 CORE_WORDS 中的某个词，则使用 CORE_WORDS 中的大写形式。
 * 非核心词条目原样返回。
 * 这是为了确保 pickCoreEntries 中 byWord.get(coreWord) 一定能命中，
 * 因为数据中 "drei"（小写）可能先于 "Drei"（大写）出现，
 * 聚合后 word 字段保留先出现的 "drei"，而 CORE_WORDS 中是 "Drei"。
 */
function canonicalizeCoreWord(entry) {
  if (!entry || typeof entry !== 'object') return entry
  if (CORE_WORDS.has(entry.word)) return entry
  // 尝试将 word 首字母大写后匹配 CORE_WORDS
  const capitalized = entry.word.charAt(0).toUpperCase() + entry.word.slice(1)
  if (CORE_WORDS.has(capitalized)) {
    return { ...entry, word: capitalized }
  }
  return entry
}

function sortEntries(entries) {
  return entries.sort((a, b) => b.freq - a.freq || a.search_term.localeCompare(b.search_term) || a.pos.localeCompare(b.pos) || a.word.localeCompare(b.word))
}

function assertOutputEntries(entries) {
  const seen = new Set()
  entries.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') fail(`第 ${index + 1} 条记录不是对象。`)
    const key = `${entry.search_term}\u0000${entry.word}\u0000${entry.pos}`
    if (seen.has(key)) fail(`发现重复记录：${key}`)
    seen.add(key)
    if (!entry.search_term || !entry.word || !entry.pos || !entry.brief) fail(`第 ${index + 1} 条记录存在空字段：${key}`)
    if (!['search_term', 'word', 'pos', 'brief'].every((field) => Object.prototype.hasOwnProperty.call(entry, field))) fail(`第 ${index + 1} 条记录字段不符合约定：${key}`)
    if (!entry.pos.split('/').every((part) => SUPPORTED_POS.has(part))) fail(`第 ${index + 1} 条记录词性不在允许集合内：${entry.pos}`)
    if (entry.brief.length > MAX_BRIEF_LENGTH) fail(`第 ${index + 1} 条记录释义过长：${entry.brief}`)
  })
}

/**
 * 核心词完整性校验：所有核心词必须存在于 entries 且 brief 非空。
 * 缺失或无效时以明确错误终止构建，不写入索引。
 */
function assertCoreWords(entries, label) {
  const bySearchTerm = new Map()
  for (const entry of entries) {
    if (!bySearchTerm.has(entry.search_term)) {
      bySearchTerm.set(entry.search_term, entry)
    }
  }

  const missing = []
  for (const coreWord of CORE_WORDS) {
    const searchTerm = normalizeSearchTerm(coreWord)
    const entry = bySearchTerm.get(searchTerm)
    if (!entry || !entry.brief) {
      missing.push(coreWord)
    }
  }

  if (missing.length > 0) {
    fail(`核心词校验失败：${label} 缺少核心词或释义无效 → ${missing.join('、')}。构建终止，不写入索引。`)
  }

  console.log(`[build-german-dictionary] ${label} 核心词校验通过：${[...CORE_WORDS].join('、')}`)
}

/**
 * 污染文本检查：扫描释义中是否残留模板、调试或 HTML 标记。
 */
function assertNoContamination(entries) {
  const CONTAMINATION_RE = /\{\{|\}\}|<[^>]+>|&\w+;|\\[a-z]+|head de-|adj de-adj|num head de/i
  const contaminated = []
  for (const entry of entries) {
    if (CONTAMINATION_RE.test(entry.brief)) {
      contaminated.push(`${entry.word}(${entry.search_term})`)
      if (contaminated.length >= 5) break
    }
  }
  if (contaminated.length > 0) {
    console.warn(`[build-german-dictionary] 警告：发现 ${contaminated.length} 条疑似污染释义：${contaminated.join('、')}`)
  }
}

function parseJsonlLine(line) {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch (error) {
    fail(`JSONL 行解析失败：${error.message}`)
    return null
  }
}

/**
 * 解析 JSONL 文本为记录数组。
 * 逐行 JSON.parse，空行静默跳过，单行解析失败时终止构建。
 */
function parseJsonl(text) {
  const records = []
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const parsed = parseJsonlLine(line)
    if (parsed) records.push(parsed)
  }
  return records
}

function parsePayload(payload) {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    if (payload.data && Array.isArray(payload.data)) return payload.data
    if (payload.entries && Array.isArray(payload.entries)) return payload.entries
    if (payload.words && Array.isArray(payload.words)) return payload.words
    if (payload.lemma || payload.word || payload.title) return [payload]
  }
  fail('数据格式不符合预期：应为数组或包含 words/entries/data 字段的对象。')
  return []
}

function decompressGzip(buffer) {
  return zlib.gunzipSync(buffer)
}

function isGzipMagic(buffer) {
  return buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b
}

function normalizePayloadBuffer(buffer, url = '') {
  const text = isGzipMagic(buffer) ? decompressGzip(buffer).toString('utf8') : buffer.toString('utf8')
  if (/jsonl|\.gz/i.test(url)) return parseJsonl(text)
  return parsePayload(JSON.parse(text))
}

async function loadRecords(args) {
  const stage = args.input ? `read_input:${args.input}` : `download:${args.url}`
  console.log(`[build-german-dictionary] 正在读取数据源：${stage}`)

  if (args.input) {
    const resolved = path.resolve(process.cwd(), args.input)
    const stats = fs.statSync(resolved)
    if (stats.size > 256 * 1024 * 1024) {
      // 大文件使用流式读取 + 逐行解析，避免内存溢出
      const result = await streamJsonlToEntries(resolved)
      if (!result.entries.length) fail('数据源未解析出任何词条记录。')
      console.log(`[build-german-dictionary] 流式处理完成：共 ${result.total} 条记录，清洗过滤 ${result.skipped} 条，可用词条 ${result.entries.length} 条`)
      return result
    }
    const buffer = fs.readFileSync(resolved)
    return normalizePayloadBuffer(buffer, args.input)
  }

  let response
  try {
    response = await fetch(args.url, { redirect: 'follow' })
  } catch (error) {
    fail(`无法发起下载请求：${error.message}`)
    return []
  }

  if (!response.ok) fail(`下载失败：HTTP ${response.status} ${response.statusText}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) fail('下载内容为空。')
  const records = normalizePayloadBuffer(buffer, args.url)
  if (!records.length) fail('数据源未解析出任何词条记录。')
  return records
}

/**
 * 同步版 buildEntries（小文件 / URL 下载场景）。
 * 按 search_term 聚合，合并同词多词性记录的释义，保留稳定词性信息。
 */
function buildEntries(records) {
  const entries = []
  const seen = new Map()
  let skipped = 0

  for (const record of records) {
    if (!filterGermanEntries(record)) {
      skipped += 1
      continue
    }
    const built = buildRecord(record)
    if (!built.length) {
      skipped += 1
      continue
    }
    const [rawEntry] = built
    const frequency = recordFrequency(record)

    // 核心词的 word 字段优先使用 CORE_WORDS 中的大写形式，
    // 确保 pickCoreEntries 中 byWord.get(coreWord) 一定能命中。
    const entry = canonicalizeCoreWord(rawEntry)

    const existing = seen.get(entry.search_term) || null
    if (!existing) {
      const wrapped = { ...entry, freq: frequency, posSet: new Set([entry.pos]) }
      seen.set(entry.search_term, wrapped)
      entries.push(wrapped)
      continue
    }
    // 合并同 search_term 不同词性的释义
    existing.posSet.add(entry.pos)
    if (existing.brief !== entry.brief && existing.brief.length + entry.brief.length + 2 <= MAX_BRIEF_LENGTH * 2) {
      existing.brief = normalizeBrief(`${existing.brief}；${entry.brief}`)
    }
    // 如果新记录的 word 是核心词大写形式，优先覆盖
    if (CORE_WORDS.has(entry.word) && !CORE_WORDS.has(existing.word)) {
      existing.word = entry.word
    }
    existing.freq = Math.max(existing.freq, frequency)
  }

  // 将 posSet 合并为稳定的 pos 字符串（按 n > v > adj > adv > prep > conj > pron > other 优先级）
  const POS_PRIORITY = { n: 1, v: 2, adj: 3, adv: 4, prep: 5, conj: 6, pron: 7, other: 8 }
  const cleaned = entries
    .map((entry) => {
      const posParts = [...entry.posSet].sort((a, b) => (POS_PRIORITY[a] || 99) - (POS_PRIORITY[b] || 99))
      return { ...entry, pos: posParts.slice(0, 2).join('/') || entry.pos }
    })
    .map(({ search_term, word, pos, brief }) => ({ search_term, word, pos, brief }))

  return { entries: sortEntries(cleaned), skipped }
}

/**
 * 逐条构建并聚合词库条目（支持流式输入，无需全部加载到内存）。
 * 按 search_term 聚合，合并同词多词性记录的释义，保留稳定词性信息。
 * @returns {Promise<{entries: object[], skipped: number, total: number}>}
 */
function streamJsonlToEntries(filePath) {
  return new Promise((resolve, reject) => {
    const entries = []
    const seen = new Map()
    let skipped = 0
    let total = 0

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity
    })

    rl.on('line', (line) => {
      total += 1
      const record = parseJsonlLine(line)
      if (!record) return

      if (!filterGermanEntries(record)) {
        skipped += 1
        return
      }
      const built = buildRecord(record)
      if (!built.length) {
        skipped += 1
        return
      }
      const [rawEntry] = built
      const frequency = recordFrequency(record)

      // 核心词的 word 字段优先使用 CORE_WORDS 中的大写形式，
      // 确保 pickCoreEntries 中 byWord.get(coreWord) 一定能命中。
      const entry = canonicalizeCoreWord(rawEntry)

      const existing = seen.get(entry.search_term) || null
      if (!existing) {
        const wrapped = { ...entry, freq: frequency, posSet: new Set([entry.pos]) }
        seen.set(entry.search_term, wrapped)
        entries.push(wrapped)
        return
      }
      // 合并同 search_term 不同词性的释义
      existing.posSet.add(entry.pos)
      if (existing.brief !== entry.brief && existing.brief.length + entry.brief.length + 2 <= MAX_BRIEF_LENGTH * 2) {
        existing.brief = normalizeBrief(`${existing.brief}；${entry.brief}`)
      }
      // 如果新记录的 word 是核心词大写形式，优先覆盖
      if (CORE_WORDS.has(entry.word) && !CORE_WORDS.has(existing.word)) {
        existing.word = entry.word
      }
      existing.freq = Math.max(existing.freq, frequency)
    })

    rl.on('close', () => {
      // 将 posSet 合并为稳定的 pos 字符串
      // 注意：entries 已按 search_term 去重（每个 search_term 仅一个 entry），
      // 这里仅做 posSet → pos 字符串的转换
      const POS_PRIORITY = { n: 1, v: 2, adj: 3, adv: 4, prep: 5, conj: 6, pron: 7, other: 8 }
      const cleaned = entries
        .map((entry) => {
          const posParts = [...entry.posSet].sort((a, b) => (POS_PRIORITY[a] || 99) - (POS_PRIORITY[b] || 99))
          return { ...entry, pos: posParts.slice(0, 2).join('/') || entry.pos }
        })
        .map(({ search_term, word, pos, brief }) => ({ search_term, word, pos, brief }))

      resolve({ entries: sortEntries(cleaned), skipped, total })
    })

    rl.on('error', reject)
  })
}

function buildCoreFallbackEntries(entries) {
  const bySearchTerm = new Map()
  for (const entry of entries) {
    if (!bySearchTerm.has(entry.search_term)) {
      bySearchTerm.set(entry.search_term, entry)
    }
  }

  const fallbacks = []
  for (const coreWord of CORE_WORDS) {
    const search_term = normalizeSearchTerm(coreWord)
    if (bySearchTerm.has(search_term)) continue
    const brief = CORE_BRIEF_FALLBACKS.get(coreWord) || coreWord
    const pos = CORE_POS_FALLBACKS.get(coreWord) || 'other'
    fallbacks.push({ search_term, word: coreWord, pos, brief })
  }
  return fallbacks
}

function pickCoreEntries(entries, maxCore) {
  const byWord = new Map()

  for (const entry of entries) {
    const word = entry.word
    // pos 可能是合并字符串如 "n/v"，取第一个词性判断优先级
    const primaryPos = entry.pos.split('/')[0]
    const posPriority = primaryPos === 'v' ? 1 : primaryPos === 'n' ? 2 : 3
    if (!byWord.has(word)) byWord.set(word, [])
    byWord.get(word).push({ posPriority, entry })
  }

  // 数据源中未生成有效释义的核心词使用固定中文兜底，确保核心词一定进入首层索引
  const fallbackEntries = buildCoreFallbackEntries(entries)
  for (const entry of fallbackEntries) {
    byWord.set(entry.word, [{ posPriority: 3, entry }])
  }

  const prioritized = []
  const seen = new Set()
  const pushUnique = (entry) => {
    const key = `${entry.search_term}\u0000${entry.pos}`
    if (seen.has(key)) return
    seen.add(key)
    prioritized.push(entry)
  }

  // 先确保核心词一定进入首层索引
  for (const coreWord of CORE_WORDS) {
    const group = byWord.get(coreWord)
    if (!group || !group.length) continue
    group.sort((a, b) => a.posPriority - b.posPriority || a.entry.pos.localeCompare(b.entry.pos) || a.entry.brief.localeCompare(b.entry.brief))
    for (const item of group) pushUnique(item.entry)
    if (prioritized.length >= maxCore) return prioritized
  }

  // 再按常规优先级填充
  for (const [word, group] of byWord.entries()) {
    if (CORE_WORDS.has(word)) continue
    group.sort((a, b) => a.posPriority - b.posPriority || a.entry.pos.localeCompare(b.entry.pos) || a.entry.brief.localeCompare(b.entry.brief))
    for (const item of group) pushUnique(item.entry)
    if (prioritized.length >= maxCore) return prioritized
  }

  return prioritized.slice(0, maxCore)
}

function ensureCoreEntriesInFull(entries, maxFull) {
  const bySearchTerm = new Map()
  for (const entry of entries) {
    if (!bySearchTerm.has(entry.search_term)) {
      bySearchTerm.set(entry.search_term, entry)
    }
  }

  const merged = [...entries]
  for (const fallback of buildCoreFallbackEntries(entries)) {
    if (bySearchTerm.has(fallback.search_term)) continue
    merged.push(fallback)
  }

  const seen = new Set()
  const deduped = merged.filter((entry) => {
    const key = `${entry.search_term}\u0000${entry.pos}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return deduped.slice(0, Math.max(maxFull, deduped.length))
}

function writeOutput(filePath, entries) {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  const payload = `${JSON.stringify(entries, null, 2)}\n`
  fs.writeFileSync(filePath, payload, 'utf8')
  return filePath
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(USAGE)
    return
  }

  if (!args.url && !args.input) {
    fail('缺少数据源参数：请提供 --url 或 --input。')
  }

  const outputDir = path.resolve(process.cwd(), args.output || DEFAULT_OUTPUT_DIR)
  const maxCore = Number.parseInt(args.maxCore || String(CORE_TARGET), 10)
  const maxFull = Number.parseInt(args.maxFull || String(FULL_TARGET), 10)
  const allowUnderTarget = Boolean(args.allowUnderTarget)
  const coreTarget = Math.min(maxCore, CORE_TARGET)
  const fullTarget = Math.min(maxFull, FULL_TARGET)

  const data = await loadRecords(args)

  let entries
  let totalRecords
  let skipped

  if (data && Array.isArray(data.entries)) {
    // 流式处理结果（大文件本地输入）
    entries = data.entries
    totalRecords = data.total
    skipped = data.skipped
  } else {
    // 普通 records 数组（小文件 / URL 下载）
    const { entries: processed, skipped: skippedCount } = buildEntries(data)
    entries = processed
    totalRecords = data.length
    skipped = skippedCount
  }

  if (!entries.length) fail('清洗后没有可用词条。')

  const fullEntries = ensureCoreEntriesInFull(entries, maxFull)
  const coreEntries = pickCoreEntries(fullEntries, maxCore)

  if (!allowUnderTarget) {
    if (fullEntries.length < fullTarget) {
      fail(`完整索引数量不足：实际 ${fullEntries.length} 条，目标 ${fullTarget} 条。可用 --allow-under-target 强制生成。`)
    }
    if (coreEntries.length < coreTarget) {
      fail(`高频首层索引数量不足：实际 ${coreEntries.length} 条，目标 ${coreTarget} 条。可用 --allow-under-target 强制生成。`)
    }
  }

  assertOutputEntries(coreEntries)
  assertOutputEntries(fullEntries)
  assertNoContamination(fullEntries)

  // 核心词完整性校验：缺失或无有效释义时终止构建，不写入索引
  assertCoreWords(coreEntries, '高频首层索引')
  assertCoreWords(fullEntries, '完整索引')

  const corePath = writeOutput(path.join(outputDir, 'index-core.json'), coreEntries)
  const fullPath = writeOutput(path.join(outputDir, 'index.json'), fullEntries)

  console.log('[build-german-dictionary] 构建摘要：')
  console.log(`  来源: ${args.input || args.url}`)
  console.log(`  原始记录: ${totalRecords}`)
  console.log(`  清洗过滤: ${skipped}`)
  console.log(`  完整索引: ${fullEntries.length}`)
  console.log(`  高频首层: ${coreEntries.length}`)
  console.log(`  输出: ${path.relative(process.cwd(), corePath)}`)
  console.log(`  输出: ${path.relative(process.cwd(), fullPath)}`)
}

main().catch((error) => {
  fail(error.message)
})

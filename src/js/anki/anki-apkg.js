import { DBG } from '../core/debug.js'
import {
  normalizeAnkiModelId,
  normalizeAnkiExportFieldNames,
  normalizeAnkiExportTemplateName
} from '../config/storage-config.js'

// APKG 生成核心：仅负责"数据 → APKG 二进制"，不持有 UI 状态、不直接触发下载。
// 设计约束：
//  1. sql.js 采用模块级懒加载缓存，首次生成时才拉取 WASM，避免影响首屏。
//  2. 异常词汇分类与 TXT 导出保持一致：整类跳过，不进入 APKG。
//  3. GUID 基于第一字段（词汇面形）做确定性生成，保证同词重复导入时 Anki 更新而非新增。

const ABNORMAL_CATEGORY_NAME = '异常词汇'

// 正式版规模上限：APKG 生成与 ZIP 打包都在主线程同步执行，超限会让页面长时间无响应，
// 因此在生成前/生成中显式拦截，而不是把风险留给浏览器。
//  - MAX_INPUT_CHARS：原始输入文本总字符数上限（2 MB），尽早拦截，避免解析和建库。
//  - MAX_EXPORT_NOTES：有效笔记条数上限（2000 条），在插入循环中到达即中止。
const MAX_INPUT_CHARS = 2 * 1024 * 1024
const MAX_EXPORT_NOTES = 2000

/**
 * 创建带稳定 code 的错误：上层 anki-output 依据 code 映射为具体中文提示，
 * 避免解析错误文本。code 同时作为 message，保持日志可读。
 */
function createCodedError(code) {
  const err = new Error(code)
  err.code = code
  return err
}

// 懒加载缓存：sql.js 初始化是异步且可重复调用的，统一收敛到 Promise 避免并发初始化。
let sqlJsPromise = null

/**
 * 将输入 sections 归一化为数组；兼容传入单个对象或 null。
 */
function normalizeSections(sections) {
  if (Array.isArray(sections)) return sections
  if (sections && typeof sections === 'object') return [sections]
  return []
}

/**
 * 校验 tagConfig 是否完整；缺少卡组/模型名时返回 null 由调用方决定提示策略。
 * 额外携带手动指定的 modelId 与字段名（均可选）：
 *  - modelId 为纯数字时用于强制复用 Anki 已有笔记类型（Anki 按内部 ID 匹配）；
 *  - fieldNames 用于让导出 schema 与目标笔记类型一致，避免 Anki 追加字段或再次克隆。
 */
function normalizeTagConfig(tagConfig) {
  if (!tagConfig || typeof tagConfig !== 'object') return null
  const deckName = String(tagConfig.deckName || '').trim()
  const modelName = String(tagConfig.modelName || '').trim()
  if (!deckName || !modelName) return null
  const modelId = normalizeAnkiModelId(tagConfig.modelId)
  // Anki 内部 ID 为 i64，而 JS Number 只对 < 2^53 的整数精确；超范围会在写入
  // models JSON / notes.mid 时发生舍入，导致 key 与 mid 不一致、无法复用目标笔记类型。
  // 因此这里显式拒绝，而不是静默生成错误 ID。
  if (modelId && !Number.isSafeInteger(Number(modelId))) {
    throw createCodedError('invalid-model-id')
  }
  return {
    deckName,
    modelName,
    modelId,
    fieldNames: normalizeAnkiExportFieldNames(tagConfig.fieldNames),
    templateName: normalizeAnkiExportTemplateName(tagConfig.templateName)
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000)
}

function nowMs() {
  return Date.now()
}

/**
 * Anki ID 生成器：基于当前毫秒时间戳递增，保证同批次内全局唯一且可预期。
 * 返回的 take() 每次递增 1，首个值与启动时间保持同一数量级。
 */
function createAnkiIdGenerator() {
  let cursor = nowMs()
  return {
    take() {
      cursor += 1
      return cursor
    }
  }
}

/**
 * 确定性字符串哈希（FNV-1a 变体）。
 * 仅用于生成稳定的 GUID 种子，不追求加密强度，但要求同输入必同输出。
 */
function deterministicHash(input) {
  const source = String(input || '')
  let h1 = 0x811c9dc5
  let h2 = 0x1000193
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i)
    h1 = (h1 ^ code) >>> 0
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 ^ ((code << 5) & 0x7fffffff)) >>> 0
    h2 = (Math.imul(h2, 0x85ebca6b) ^ (h2 >>> 13)) >>> 0
  }
  const bytes = new Array(8).fill(0)
  bytes[0] = h1 & 0xff
  bytes[1] = (h1 >>> 8) & 0xff
  bytes[2] = (h1 >>> 16) & 0xff
  bytes[3] = (h1 >>> 24) & 0xff
  bytes[4] = h2 & 0xff
  bytes[5] = (h2 >>> 8) & 0xff
  bytes[6] = (h2 >>> 16) & 0xff
  bytes[7] = (h2 >>> 24) & 0xff
  let hex = ''
  for (let i = 0; i < 8; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

/**
 * 把确定性哈希转成 Anki GUID 样式（8-4-4-4-12）。
 * 用面形 + 固定盐值保证同词同 GUID；不同词几乎不可能碰撞。
 * extraSeed 用于"同一包内多模型/多卡组"场景：同一词条落到不同模板或卡组时
 * 必须拥有不同 GUID，否则 Anki 的 notes.guid 唯一索引会导致导入失败。
 * 单模型场景传空串，GUID 与历史行为完全一致（重复导入仍是"更新"而非"新增"）。
 */
function toAnkiGuid(frontField, extraSeed = '') {
  const seed = extraSeed ? `${frontField}\x1fNJAPKG\x1f${extraSeed}` : `${frontField}\x1fNJAPKG`
  const hash = deterministicHash(seed).slice(0, 32).padEnd(32, '0')
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    hash.slice(12, 16),
    hash.slice(16, 20),
    hash.slice(20, 32)
  ].join('-')
}

/**
 * 字段数补齐到 fieldCount：Anki 的 equal_schema 要求笔记 flds 数量与笔记类型字段数严格一致。
 * Prompt 约定输出 3 字段，但目标笔记类型可能更多（例如第 4 个字段由用户手动补充）；
 * 缺失的尾部字段用空串占位，多余字段直接截断，避免导入时字段数与模型不匹配。
 */
function normalizeFieldList(fields, fieldCount) {
  const count = Number.isInteger(fieldCount) && fieldCount > 0 ? fieldCount : 3
  const next = Array.isArray(fields) ? fields.slice(0, count) : []
  while (next.length < count) next.push('')
  return next.map((field) => String(field ?? '').trim())
}

function normalizeLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * 解析单个 section 的正文为字段数组；少于 2 列的行直接丢弃，避免脏数据进库。
 * fieldCount 透传给 normalizeFieldList，保证每条笔记的字段数与笔记类型一致。
 */
function parseNoteLines(section, fieldCount) {
  const lines = normalizeLines(section?.text)
  const notes = []
  for (const line of lines) {
    const fields = line.split('|').map((field) => field.trim())
    if (fields.length < 2) continue
    notes.push(normalizeFieldList(fields, fieldCount))
  }
  return notes
}

/**
 * 构建 Anki 笔记类型（NotetypeSchema11）JSON。
 * Anki 端用 serde 强校验，必填字段缺一即导入失败：
 * id/name/type/mod/usn/sortf/tmpls/flds/css 为必填，另按官方导出补齐 did/latexPre/latexPost。
 * 取自 Anki notetype/schema11.rs 的 NotetypeSchema11。
 *
 * 复用已有笔记类型的关键：
 *  1. id 必须是目标笔记类型的内部数字 ID；否则 Anki 视为全新类型。
 *  2. fields 名称与数量需与目标一致——Anki 的 equal_schema 会逐位按名比对，
 *     名称不同在合并模式下会追加字段、非合并模式下会克隆出新类型。
 *  3. templates 名称同理按名匹配，名称不一致会追加模板从而多出一张卡片。
 *  4. 手动指定 modelId 时，模型 mod 固定为 0，避免 Anki 将导出包中的占位 CSS/模板视为更新并覆盖已有样式。
 */
function buildModelJson(modelId, modelName, fieldNames, templateName, preserveExisting) {
  // mod 为 0 时，导入已有 ID 的笔记类型不会被当成更新版本，避免导出包中的占位 CSS/模板覆盖 Anki 原模板。
  const now = preserveExisting ? 0 : nowSeconds()
  const css = '.card { font-family: Arial; font-size: 20px; }'
  // 动态生成字段：数量与顺序必须与目标笔记类型完全一致（equal_schema 逐位比对），
  // 比硬编码 3 个更安全——字段数不符时 Anki 会克隆出新类型并给名字追加 "+"。
  const names = Array.isArray(fieldNames) && fieldNames.length > 0
    ? fieldNames
    : ['Front', 'Back', 'Example']
  const flds = names.map((name, ord) => ({
    name: String(name || `Field${ord + 1}`),
    ord,
    sticky: false,
    rtl: false,
    font: 'Arial',
    size: 20
  }))
  // 模板引用全部字段：正面显示第 1 个字段，背面依次显示其余字段。
  const front = names[0]
  const afmt = names.map((name) => `{{${name}}}`).join('<br>')
  return {
    [String(modelId)]: {
      id: modelId,
      name: modelName,
      type: 0,
      mod: now,
      usn: -1,
      sortf: 0,
      did: null,
      flds,
      tmpls: [
        {
          name: templateName,
          ord: 0,
          qfmt: `{{${front}}}`,
          afmt
        }
      ],
      css,
      latexPre: '',
      latexPost: '',
      req: [[0, 'all', [0]]]
    }
  }
}

/**
 * 构建 Anki 卡组（DeckSchema11 → NormalDeckSchema11）JSON。
 * Anki serde 强校验：除 id/name/mod/usn/conf/dyn 外，desc 有默认值，
 * 但 collapsed 与 lrnToday/revToday/newToday/timeToday 为必填（缺则导入报错）。
 * today 各值为 [天数, 数量] 元组。取自 Anki decks/schema11.rs。
 */
function buildDeckJson(deckId, deckName) {
  // mod 为 TimestampSecs（秒）。
  const now = nowSeconds()
  return {
    [String(deckId)]: {
      id: deckId,
      name: deckName,
      mod: now,
      usn: -1,
      desc: '',
      dyn: 0,
      collapsed: false,
      conf: 1,
      lrnToday: [0, 0],
      revToday: [0, 0],
      newToday: [0, 0],
      timeToday: [0, 0]
    }
  }
}

/**
 * 构建 col.conf（Anki schema11 全局配置块）。
 * 直接采用 Anki 官方 schema11_config_as_string 的默认键集，避免缺键导致升级/导入异常；
 * 其中 curModel/curDeck/activeDecks 需指向本包真实存在的模型与卡组 id。
 * 取值为 Anki 默认值：newSpread/collapseTime/timeLim/nextPos/sortType 等。
 * @param {number|string} modelId - 当前模型 id（多模型时取第一个）
 * @param {number|string} deckId - 当前卡组 id（多卡组时取第一个）
 * @param {Array<number|string>} [deckIds] - 本包包含的全部卡组 id，写入 activeDecks
 */
function buildCollectionConfJson(modelId, deckId, deckIds = []) {
  const activeDecks = deckIds.length ? deckIds : [deckId]
  return JSON.stringify({
    activeDecks,
    curDeck: deckId,
    newSpread: 0,
    collapseTime: 1200,
    timeLim: 0,
    estTimes: true,
    dueCounts: true,
    curModel: String(modelId),
    nextPos: 1,
    sortType: 'noteFld',
    sortBackwards: false,
    addToCur: true,
    dayLearnFirst: false,
    schedVer: 2,
    creationOffset: null,
    sched2021: true
  })
}

/**
 * 构建 Anki 卡组配置（DeckConfSchema11）JSON。
 * Anki 用 serde 强校验：maxTaken/autoplay/timer 与 new/rev/lapse 均为必填，
 * 任一缺失即报 "decoding deck config: missing field `maxTaken`" 之类的错误。
 * 数值全部取 Anki 官方默认，确保导入后使用标准复习参数。
 * 取自 Anki deckconfig/schema11.rs。
 */
function buildDeckConfigJson() {
  return {
    '1': {
      id: 1,
      mod: 0,
      name: '默认卡组配置',
      usn: -1,
      maxTaken: 60,
      autoplay: true,
      timer: 0,
      replayq: true,
      dyn: false,
      new: {
        bury: false,
        delays: [1.0, 10.0],
        initialFactor: 2500,
        ints: [1, 4, 0],
        order: 1,
        perDay: 20
      },
      rev: {
        bury: false,
        ease4: 1.3,
        ivlFct: 1.0,
        maxIvl: 36500,
        perDay: 200,
        hardFactor: 1.2
      },
      lapse: {
        delays: [10.0],
        leechAction: 1,
        leechFails: 8,
        minInt: 1,
        mult: 0.0
      }
    }
  }
}

function buildSchemaSql() {
  return `
CREATE TABLE col (
  id INTEGER PRIMARY KEY,
  crt INTEGER,
  mod INTEGER,
  scm INTEGER,
  ver INTEGER,
  dty INTEGER,
  usn INTEGER,
  ls INTEGER,
  conf TEXT,
  models TEXT,
  decks TEXT,
  dconf TEXT,
  tags TEXT
);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  guid TEXT,
  mid INTEGER,
  mod INTEGER,
  usn INTEGER,
  tags TEXT,
  flds TEXT,
  sfld TEXT,
  csum INTEGER,
  flags INTEGER,
  data TEXT
);

CREATE TABLE cards (
  id INTEGER PRIMARY KEY,
  nid INTEGER,
  did INTEGER,
  ord INTEGER,
  mod INTEGER,
  usn INTEGER,
  type INTEGER,
  queue INTEGER,
  due INTEGER,
  ivl INTEGER,
  factor INTEGER,
  reps INTEGER,
  lapses INTEGER,
  left INTEGER,
  odue INTEGER,
  odid INTEGER,
  flags INTEGER,
  data TEXT
);

CREATE TABLE revlog (
  id INTEGER PRIMARY KEY,
  cid INTEGER,
  usn INTEGER,
  ease INTEGER,
  ivl INTEGER,
  lastIvl INTEGER,
  factor INTEGER,
  time INTEGER,
  type INTEGER
);

CREATE TABLE graves (
  usn INTEGER NOT NULL,
  oid INTEGER NOT NULL,
  type INTEGER NOT NULL
);

CREATE INDEX ix_notes_usn ON notes (usn);
CREATE INDEX ix_cards_usn ON cards (usn);
CREATE INDEX ix_cards_nid ON cards (nid);
CREATE INDEX ix_cards_sched ON cards (did, queue, due);
CREATE INDEX ix_revlog_usn ON revlog (usn);
CREATE INDEX ix_revlog_cid ON revlog (cid);
CREATE INDEX ix_notes_csum ON notes (csum);
`
}

/**
 * APKG 容器内的 media 清单：当前不内嵌任何媒体文件，固定为空 JSON 对象。
 */
function buildMediaManifest() {
  return new TextEncoder().encode('{}')
}

function resolveWasmUrl() {
  const base = import.meta.env?.BASE_URL || '/'
  return `${base}sql-wasm.wasm`
}

/**
 * 懒加载 sql.js 引擎；WASM 位置依赖 Vite 的 BASE_URL，保证 GitHub Pages 子路径部署可用。
 * 失败时清空缓存并抛出带 code 的错误，便于调用方区分"引擎加载失败"与"生成失败"并允许重试。
 */
async function loadSqlJs() {
  if (sqlJsPromise) return sqlJsPromise
  sqlJsPromise = (async () => {
    try {
      const sqlJsModule = await import('sql.js')
      const initSqlJs = sqlJsModule.default || sqlJsModule
      const SQL = await initSqlJs({
        locateFile: () => resolveWasmUrl()
      })
      DBG('anki:apkg:engine', { wasm: resolveWasmUrl() })
      return SQL
    } catch (err) {
      // 关键：失败后必须清空缓存，否则被拒绝的 Promise 会被永久复用，用户无法重试。
      sqlJsPromise = null
      DBG('anki:apkg:engine:fail', String(err && err.message || err))
      const wrapped = new Error('anki-apkg:engine-load-failed')
      wrapped.code = 'engine-load-failed'
      wrapped.cause = err
      throw wrapped
    }
  })()
  return sqlJsPromise
}

/**
 * 归一化导出分组：每组 = { config, sections }。
 * config 由 normalizeTagConfig 归一化；sections 为该组待写入的分类文本。
 * 单篇导出等价于"只有一组的批量导出"，因此两条路径共用同一套建库逻辑。
 */
function normalizeGroups(groups) {
  const list = Array.isArray(groups) ? groups : []
  const out = []
  for (const group of list) {
    const config = normalizeTagConfig(group?.tagConfig)
    if (!config) {
      throw createCodedError('invalid-tag-config')
    }
    out.push({ config, sections: normalizeSections(group?.sections) })
  }
  return out
}

/**
 * 模型身份键：手动指定 ID 时以 ID 为准（Anki 按内部数字 ID 匹配笔记类型），
 * 否则用"模型名 + 字段名 + 模板名"区分，保证同一包内不同模板不会互相覆盖。
 */
function modelIdentityKey(config) {
  const definition = `${config.modelName}\u001f${config.fieldNames.join('\u001f')}\u001f${config.templateName}`
  if (config.modelId) return `id:${config.modelId}\u001f${definition}`
  return `auto:${definition}`
}

/**
 * 构建 Anki 2.1 的 collection.anki2 字节流；返回数据库内容与统计信息。
 * 支持一个包内包含多组（笔记 + 导出配置）：每组按自己的配置写入对应卡组与笔记类型，
 * 同名卡组 / 同定义模板在包内复用同一份定义。
 * 资源生命周期用 try/finally 兜底：sql.js 的 Database/Statement 是 WASM 侧资源，
 * 任意一步（建库、建表、插入、导出）抛错都必须释放，否则连续失败会累积内存压力。
 */
async function buildCollectionBytes(groups) {
  const SQL = await loadSqlJs()
  let db = null
  let noteStmt = null
  let cardStmt = null
  // 同一批导出共用秒级时间戳：notes/cards 的 mod 单位为秒；统一取值可减少循环内调用，
  // 并保证整批数据修改时间一致、可预期。
  const exportNowSeconds = nowSeconds()
  const noteIds = createAnkiIdGenerator()
  const cardIds = createAnkiIdGenerator()
  const modelIds = createAnkiIdGenerator()
  const deckIds = createAnkiIdGenerator()
  let noteCount = 0
  let cardCount = 0

  try {
    db = new SQL.Database()

    // 1) 归组：模型按身份键去重，卡组按名称去重。
    //    手动指定同一个 modelId 却对应不同模板定义属于配置冲突，直接报错而不是静默覆盖。
    const modelMap = new Map()
    const deckMap = new Map()
    const manualModelOwners = new Map()
    const reservedModelIds = new Set(groups.map((group) => group.config.modelId).filter(Boolean))
    for (const group of groups) {
      const identity = modelIdentityKey(group.config)
      if (!modelMap.has(identity)) {
        let id
        if (group.config.modelId) {
          const owner = manualModelOwners.get(group.config.modelId)
          if (owner && owner !== identity) {
            throw createCodedError('duplicate-model-id')
          }
          manualModelOwners.set(group.config.modelId, identity)
          id = Number(group.config.modelId)
        } else {
          do { id = modelIds.take() } while (reservedModelIds.has(String(id)))
          reservedModelIds.add(String(id))
        }
        modelMap.set(identity, { id, config: group.config })
      }
      const deckName = group.config.deckName
      if (!deckMap.has(deckName)) {
        deckMap.set(deckName, { id: deckIds.take(), name: deckName })
      }
      group.modelIdentity = identity
      group.deckName = deckName
    }

    // 2) 合并模型与卡组定义：col.models / col.decks 都是"id -> 定义"的 JSON 对象。
    const modelsJson = {}
    for (const entry of modelMap.values()) {
      Object.assign(modelsJson, buildModelJson(
        entry.id,
        entry.config.modelName,
        entry.config.fieldNames,
        entry.config.templateName,
        Boolean(entry.config.modelId)
      ))
    }
    const decksJson = {}
    for (const entry of deckMap.values()) {
      Object.assign(decksJson, buildDeckJson(entry.id, entry.name))
    }

    const firstModel = modelMap.values().next().value
    const firstDeck = deckMap.values().next().value
    const allDeckIds = [...deckMap.values()].map((entry) => entry.id)

    db.run(buildSchemaSql())
    db.run(
      `INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        1,
        exportNowSeconds,
        nowMs(),
        nowMs(),
        11,
        0,
        0,
        0,
        buildCollectionConfJson(firstModel.id, firstDeck.id, allDeckIds),
        JSON.stringify(modelsJson),
        JSON.stringify(decksJson),
        // dconf 必须是完整的 DeckConfSchema11，缺 maxTaken 等必填字段会被 Anki 拒绝导入。
        JSON.stringify(buildDeckConfigJson()),
        // col.tags 是「标签名 -> 使用次数」的映射（JSON object），不是数组；
        // 写成 [] 会报 "invalid type: sequence, expected a map"。Anki 官方 schema11.sql 也以 '{}' 初始化。
        '{}'
      ]
    )
    // sql.js 的 Statement 只有 free()（释放 finalize），没有 close()；close() 是 Database 的方法。
    // 误用 close() 会抛 "noteStmt.close is not a function"，被上层捕获后统一显示为导出失败。
    // run() 内部已自动 step + reset，循环复用同一语句是安全的，此处仅需在结束时释放。
    noteStmt = db.prepare(`INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    cardStmt = db.prepare(`INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, reps, lapses, left, odue, odid, flags, data)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

    // 3) 写入笔记：每条笔记按所属分组的配置写入对应 mid（模板）与 did（卡组）。
    //    GUID 作用域：单模板包沿用"仅按词面形"的旧口径（重复导入仍是更新而非新增）；
    //    多模板包必须把模板身份并入种子，否则同词落到不同模板会撞 Anki 的 guid 唯一约束。
    const routeKeys = new Set(groups.map((group) => `${group.modelIdentity}\u001f${group.deckName}`))
    const multiRoute = routeKeys.size > 1
    const seenNotes = new Set()
    for (const group of groups) {
      const modelEntry = modelMap.get(group.modelIdentity)
      const deckEntry = deckMap.get(group.deckName)
      // 每条笔记的字段数必须与笔记类型字段数一致；以用户配置的字段名为准（默认 3）。
      const fieldCount = modelEntry.config.fieldNames.length
      const guidScope = multiRoute ? `${group.modelIdentity}\u001f${group.deckName}` : ''
      for (const section of group.sections) {
        if (section?.name && section.name === ABNORMAL_CATEGORY_NAME) continue
        const notes = parseNoteLines(section, fieldCount)
        for (const fields of notes) {
          // 同一模板下同词只保留一条：Anki 以 guid 标识笔记，重复词条会造成导入冲突。
          const dedupeKey = `${group.modelIdentity}\u001f${group.deckName}\u001f${fields[0]}`
          if (seenNotes.has(dedupeKey)) continue
          // 规模上限只计算真正写入的有效笔记，重复词条不应耗尽额度。
          if (noteCount >= MAX_EXPORT_NOTES) {
            throw createCodedError('note-limit-exceeded')
          }
          seenNotes.add(dedupeKey)
          const noteId = noteIds.take()
          const cardId = cardIds.take()
          const flds = fields.join('\u001f')
          const guid = toAnkiGuid(fields[0], guidScope)
          noteStmt.run([
            noteId,
            guid,
            modelEntry.id,
            // notes.mod 为 TimestampSecs（秒）；写毫秒会落在数万年后且被 Anki 原样保留。
            exportNowSeconds,
            0,
            '',
            flds,
            fields[0],
            0,
            0,
            ''
          ])
          cardStmt.run([
            cardId,
            noteId,
            deckEntry.id,
            0,
            exportNowSeconds,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
            ''
          ])
          noteCount += 1
          cardCount += 1
        }
      }
    }
    return { dbBytes: db.export(), noteCount, cardCount }
  } finally {
    // 清理异常不得覆盖原始生成异常：逐个隔离并仅记录调试日志。
    try { noteStmt?.free() } catch (err) { DBG('anki:apkg:cleanup:noteStmt', String(err && err.message || err)) }
    try { cardStmt?.free() } catch (err) { DBG('anki:apkg:cleanup:cardStmt', String(err && err.message || err)) }
    try { db?.close() } catch (err) { DBG('anki:apkg:cleanup:db', String(err && err.message || err)) }
  }
}

/**
 * 生成 APKG 二进制（ZIP 容器）：
 *  - collection.anki2：SQLite 数据库
 *  - media：空 JSON（当前无媒体）
 * 返回 { bytes, noteCount, cardCount }：字节可直接交给 triggerDownload，
 * 统计信息用于上层展示真实导出数量（而非分类数量）。
 * 失败时抛出带稳定 code 的错误：invalid-tag-config / input-too-large /
 * invalid-model-id / duplicate-model-id / note-limit-exceeded / empty-export / engine-load-failed。
 */
export async function generateApkg(sections, tagConfig) {
  return generateApkgBatch([{ sections, tagConfig }])
}

/**
 * 批量生成单个 APKG：多组（笔记 + 导出配置）合并进同一个包。
 * 每组按自己的配置写入对应卡组与笔记类型；同名卡组与同定义模板在包内复用。
 * @param {Array<{sections: Array, tagConfig: object}>} groups
 */
export async function generateApkgBatch(groups) {
  const normalizedGroups = normalizeGroups(groups)
  if (!normalizedGroups.length) {
    throw createCodedError('invalid-tag-config')
  }
  // 规模门槛前置：在解析/建库之前先估算原始文本量，超限直接失败，避免无谓的 CPU 与内存开销。
  const inputChars = normalizedGroups.reduce((sum, group) => sum + group.sections.reduce(
    (inner, section) => inner + String(section?.text || '').length, 0
  ), 0)
  if (inputChars > MAX_INPUT_CHARS) {
    DBG('anki:apkg:input-too-large', { inputChars, limit: MAX_INPUT_CHARS, groups: normalizedGroups.length })
    throw createCodedError('input-too-large')
  }
  const { dbBytes, noteCount, cardCount } = await buildCollectionBytes(normalizedGroups)
  // 空导出拦截：没有有效词条时不再打包，避免下载一个空 APKG 让用户误以为导出成功。
  if (noteCount === 0 || cardCount === 0) {
    DBG('anki:apkg:empty', { noteCount, cardCount })
    throw createCodedError('empty-export')
  }
  const fflate = await import('fflate')
  const apkgBytes = fflate.zipSync(
    {
      'collection.anki2': dbBytes,
      media: buildMediaManifest()
    },
    { level: 0 }
  )
  DBG('anki:apkg:generate', {
    length: apkgBytes.length,
    dbLength: dbBytes.length,
    noteCount,
    cardCount,
    groups: normalizedGroups.length
  })
  return { bytes: apkgBytes, noteCount, cardCount }
}

/**
 * APKG 生成互斥锁：全量导出、单分类导出与批量导出共享同一把锁。
 * 按钮级 disabled 只覆盖各自按钮，无法阻止"生成中再点另一个导出"，
 * 因此必须在业务层拒绝并发——否则会同时建两份 SQLite 并同步 ZIP，造成内存峰值与卡顿。
 * 策略：已有导出进行时直接拒绝新请求（不排队、不取消），并由调用方在 finally 释放。
 */
let apkgGenerating = false

/** 申请 APKG 生成执行权；已有生成任务时返回 false。 */
export function acquireApkgGeneration() {
  if (apkgGenerating) return false
  apkgGenerating = true
  return true
}

/** 释放 APKG 生成执行权。 */
export function releaseApkgGeneration() {
  apkgGenerating = false
}

/** 查询当前是否有 APKG 生成任务在运行。 */
export function isApkgGenerating() {
  return apkgGenerating
}

/**
 * 判断某分类是否为约定的异常词汇分类（精确匹配，与 TXT 导出规则保持一致）。
 */
export function isAbnormalCategory(name) {
  return String(name || '') === ABNORMAL_CATEGORY_NAME
}

export default { generateApkg, generateApkgBatch, isAbnormalCategory }

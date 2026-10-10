import { DBG } from '../core/debug.js'
import { showToast, showGistUploading, showGistUploaded, hideGistIndicator } from '../ui.js'
import { I18N, t } from '../locales.js'
import { debounce } from '../utils/throttle.js'
import { getTodayDateString } from '../core/date.js'
import {
  getGistSettings,
  setGistSettings,
  persistGistSettings,
  markGistSyncSuccess,
  getLastGistUpdatedAt,
  hasGistCredentials,
  reloadGistSyncBaselineFromStorage
} from '../core/settings-store.js'
import { normalizeGistSettings, normalizeCompletionHistory } from '../config/storage-config.js'
import { gistApiRequest, gistErrorMessage, GIST_FILENAME } from './gist-api.js'
import { buildExportPayload, keyOmitReasonText } from './snapshot.js'
import {
  validateBackupPayload,
  captureImportStorageSnapshot,
  restoreImportStorageSnapshot
} from './json.js'
import { errorHandler, ErrorTypes, ErrorSeverity } from '../core/error-handler.js'
import { renderWorkflow } from '../workflow/workflow-renderer.js'
import { renderMemos, updateMemoCounters, renderTagSelector } from '../memo/memo-renderer.js'
import {
  setCompletionHistory,
  setLastResetDate,
  persistCompletionHistory,
  persistLastResetDate,
  restoreTodayCompletedFromHistory,
  getCompletionHistory,
  getLastResetDate
} from '../workflow/history-store.js'
import {
  setWorkflows,
  persistWorkflows,
  getWorkflows
} from '../workflow/workflow-store.js'
import { setRotationRules, persistRotationRules, getRotationRules } from '../workflow/rotation-store.js'
import { replaceMemos, persistMemos, setMemoTags, persistMemoTags, getMemos, getMemoTags } from '../memo/memo-store.js'
import { parseMemoContentToMap } from '../memo/memo-parser.js'
import { getCompletedIds } from '../workflow/completion-store.js'
import { setUserSettings, persistUserSettings, getUserSettings } from '../core/settings-store.js'
import { setAnkiSettings, persistAnkiSettings, getAnkiProfiles, getAnkiSettings } from '../anki/anki-store.js'
import { setAnkiExportSettings, persistAnkiExportSettings, getAnkiExportSettings } from '../anki/anki-export-store.js'
import { normalizeAnkiSettings } from '../config/storage-config.js'
import { renderAnkiSettingsInputs } from '../anki/anki-settings.js'
import { decryptAnkiSecret } from '../anki/anki-crypto.js'
import { getEffectivePassphrase } from '../anki/anki-passphrase.js'
import { registerAutoUploadHandler, suspendAutoUpload, resumeAutoUpload } from '../core/sync-hooks.js'
import { openConfirmDialog } from '../settings/modal.js'

// 上传后回读校验失败时的最大重试轮数。
// 每轮都会重新执行「冲突检测 → 合并远端 → 构建 → PATCH → 回读校验」，
// 2 轮足以覆盖绝大多数「GET/PATCH 夹缝写入」；设为有限值避免多设备持续互写时无限循环。
const MAX_UPLOAD_ATTEMPTS = 2

/**
 * 生成用于诊断的稳定内容指纹；不用于跳过冲突检测或判断本地已同步。
 */
function stableFingerprint(payload) {
  return JSON.stringify({ version: payload.version, data: payload.data })
}

/**
 * GitHub Gist 云端同步：
 *  - uploadToGist()：把当前快照推送到 Gist
 *  - pullFromGist({ silent })：把 Gist 拉回并应用到本地
 *  - scheduleAutoUpload()：persist* 触发的去抖自动上传
 *  - saveGistSettingsFromInputs()：UI 双向绑定
 *  - renderGistSettingsInputs()：渲染状态行
 *  - setGistBusy(action)：上传/拉取中按钮状态
 */

/**
 * 把 .json 解析后的备份数据原地应用到 in-memory 各 store，
 * 同时调用各 store 的 *render* 入口做 UI 刷新。
 *
 *  - 先把完成态应用到 history / completedIds
 *  - 触发跨天判断，确认最后重置日一致
 *  - 重新拉取 task / rotation / memo / tag 状态并重新渲染
 */
function snapshotMemoryStores() {
  // 深拷贝各 store 当前状态：setXxx 会重建对象/数组，但为防御未来实现就地修改，
  // 回滚快照必须与运行时对象解耦，避免回滚时把被污染后的引用再写回去。
  return {
    workflows: JSON.parse(JSON.stringify(getWorkflows() || [])),
    rotationRules: JSON.parse(JSON.stringify(getRotationRules() || [])),
    memos: JSON.parse(JSON.stringify(getMemos() || [])),
    completionHistory: JSON.parse(JSON.stringify(getCompletionHistory() || {})),
    lastResetDate: getLastResetDate() || '',
    userSettings: JSON.parse(JSON.stringify(getUserSettings() || {})),
    ankiSettings: JSON.parse(JSON.stringify(getAnkiSettings() || {})),
    ankiExportSettings: JSON.parse(JSON.stringify(getAnkiExportSettings() || {})),
    memoTags: JSON.parse(JSON.stringify(getMemoTags() || []))
  }
}

function restoreMemoryStores(snapshot) {
  if (!snapshot) return
  // 逐个独立 try/catch：任一 store 的 setter 异常不得阻断其余 store 回滚。
  const steps = [
    ['workflows', () => setWorkflows(snapshot.workflows)],
    ['rotationRules', () => setRotationRules(snapshot.rotationRules)],
    ['memos', () => replaceMemos(snapshot.memos)],
    ['completionHistory', () => setCompletionHistory(snapshot.completionHistory)],
    ['lastResetDate', () => { if (typeof snapshot.lastResetDate === 'string') setLastResetDate(snapshot.lastResetDate) }],
    ['userSettings', () => setUserSettings(snapshot.userSettings)],
    ['ankiSettings', () => setAnkiSettings(snapshot.ankiSettings)],
    ['ankiExportSettings', () => setAnkiExportSettings(snapshot.ankiExportSettings, { emit: false, source: 'external:gist-pull-rollback' })],
    ['memoTags', () => setMemoTags(snapshot.memoTags)]
  ]
  for (const [name, fn] of steps) {
    try {
      fn()
    } catch (err) {
      DBG('gist-pull:rollback:error', { store: name, err: String(err) })
    }
  }
}

/**
 * 事务式应用导入状态：
 *  1. 先快照 localStorage 与全部 store 内存；
 *  2. 写内存 setter + 逐个 persist*，任一持久化返回 false 即视为失败；
 *  3. 失败时同时回滚 localStorage 与内存，返回 { ok:false, reason }，绝不留下半写状态。
 *
 * 返回 { ok:true } 或 { ok:false, reason }。调用方据此决定是否标记同步成功 / 提示失败。
 */
function applyImportedState({ workflows, rotationRules, memos, completionHistory, lastResetDate, userSettings, ankiSettings, ankiExportSettings, memoTags }) {
  suspendAutoUpload()
  const prevStorage = captureImportStorageSnapshot()
  const prevMemory = snapshotMemoryStores()
  try {
    setWorkflows(workflows)
    setRotationRules(rotationRules)
    replaceMemos(memos)
    setCompletionHistory(completionHistory)
    if (typeof lastResetDate === 'string') setLastResetDate(lastResetDate)
    if (userSettings) setUserSettings(userSettings)
    if (ankiSettings) setAnkiSettings(ankiSettings)
    if (ankiExportSettings) setAnkiExportSettings(ankiExportSettings, { emit: true, source: 'external:gist-pull' })
    if (Array.isArray(memoTags)) setMemoTags(memoTags)

    // 持久化结果必须逐项校验：任一写入失败都意味着磁盘与内存不一致，
    // 必须整体回滚，否则刷新页面后会出现"部分新、部分旧"的损坏数据。
    const writes = [
      ['workflows', () => persistWorkflows()],
      ['rotationRules', () => persistRotationRules()],
      ['memos', () => persistMemos()],
      ['completionHistory', () => persistCompletionHistory()],
      ['lastResetDate', () => persistLastResetDate()],
      ['userSettings', () => persistUserSettings()],
      ['ankiSettings', () => (ankiSettings ? persistAnkiSettings() : true)],
      // ankiExportSettings 走纯内存 setter，必须在此显式落盘，否则刷新后配置丢失
      ['ankiExportSettings', () => (ankiExportSettings ? persistAnkiExportSettings() : true)],
      ['memoTags', () => (Array.isArray(memoTags) ? persistMemoTags() : true)]
    ]
    for (const [name, fn] of writes) {
      let ok = false
      try {
        ok = fn()
      } catch (err) {
        DBG('gist-pull:persist:error', { domain: name, err: String(err) })
        ok = false
      }
      if (!ok) {
        DBG('gist-pull:persist:fail', { domain: name })
        restoreImportStorageSnapshot(prevStorage)
        restoreMemoryStores(prevMemory)
        return { ok: false, reason: `persist-failed:${name}` }
      }
    }
  } finally {
    resumeAutoUpload()
  }
  DBG('gist-pull:applied', {
    workflows: workflows.length,
    rotationRules: rotationRules.length,
    memos: memos.length,
    historyDays: Object.keys(completionHistory).length,
    ankiProfileCount: Array.isArray(ankiSettings?.profiles) ? ankiSettings.profiles.length : 0,
    memoTags: Array.isArray(memoTags) ? memoTags.length : 0
  })
  return { ok: true }
}

/**
 * Gist 操作串行队列：
 * 上传 / 拉取（含冲突检测触发的拉取）都必须排队执行。若允许并发，两个操作会
 * 同时读取同一份本地版本基线并各自发起请求，导致「反复判定冲突 → 反复撤销用户操作」。
 *
 * 注意：队列是 promise 链，任务内部若再次入队会造成死锁，因此内部流程一律调用
 * 不带队列的 *Internal 版本，只有对外的 uploadToGist / pullFromGist 才入队。
 *
 * 跨标签页协调：上述 promise 链只能串行化「当前页面实例」内的操作，无法阻止同一浏览器
 * 的另一个标签页同时写同一个 Gist（各标签页的队列互不可见）。因此在链式串行的基础上，
 * 再用 Web Locks 获取一个同源独占锁——它跨标签页生效。拿不到 Web Locks 时降级为仅链式串行。
 * 无 Web Locks 的浏览器仍必须依赖冲突检测；它不能提供跨标签页互斥保证。
 *
 * 拿到锁后先重读共享的 Gist 基线（lastGistUpdatedAt 存在 localStorage，跨标签页共享），
 * 避免用本标签页的陈旧基线做冲突检测而误判「无冲突」。
 */
const GIST_LOCK_NAME = 'njw-gist-sync'

let gistOperationChain = Promise.resolve()

function enqueueGistOperation(task) {
  const run = async () => {
    const withFreshBaseline = async () => {
      reloadGistSyncBaselineFromStorage()
      return task()
    }
    const locks = typeof navigator !== 'undefined' ? navigator.locks : null
    if (locks && typeof locks.request === 'function') {
      return locks.request(GIST_LOCK_NAME, { mode: 'exclusive' }, withFreshBaseline)
    }
    return withFreshBaseline()
  }
  const result = gistOperationChain.then(run, run)
  gistOperationChain = result.then(() => {}, () => {})
  return result
}

/**
 * 导入（拉取 / 冲突合并）应用完成后统一刷新各视图。
 */
function renderAfterImport() {
  renderWorkflow()
  renderMemos()
  updateMemoCounters()
  renderTagSelector()
  renderAnkiSettingsInputs()
}

/**
 * 生词查重归一化：与 memo-store 的 normalizeForDedupe 保持一致
 * （去首尾空白 + 忽略大小写 + NFC 归一化），保证合并去重结果与手动添加一致。
 */
function normalizeWord(text) {
  return String(text || '').trim().normalize('NFC').toLowerCase()
}

/**
 * 合并两张生词卡片的正文：按分类块取并集，分类内单词去重（保留先出现的写法）。
 * 这是"不丢词"的核心：同一天同一标签的卡片在两台设备上会被分别追加，
 * 直接覆盖必然丢掉另一侧的新词，只有逐词并集才能保住双方。
 */
function mergeMemoContent(a, b) {
  const mapA = parseMemoContentToMap(a)
  const mapB = parseMemoContentToMap(b)
  const cats = []
  const seenCat = new Set()
  for (const src of [mapA, mapB]) {
    for (const cat of Object.keys(src)) {
      if (!seenCat.has(cat)) {
        seenCat.add(cat)
        cats.push(cat)
      }
    }
  }
  const blocks = []
  for (const cat of cats) {
    const words = []
    const seenWord = new Set()
    for (const list of [mapA[cat] || [], mapB[cat] || []]) {
      for (const w of list) {
        const key = normalizeWord(w)
        if (!key || seenWord.has(key)) continue
        seenWord.add(key)
        words.push(w)
      }
    }
    if (words.length) blocks.push(`${cat}：\n${words.join('\n')}`)
  }
  return blocks.join('\n\n')
}

/**
 * 生词合并：以「标签 + 日期」为身份（同一标签同一天的词都写在同一条卡片里）。
 * 本地优先保留 id / 时间戳，两侧正文按分类取并集；仅一侧存在的卡片原样保留。
 * 最后按时间戳倒序排列，保持与列表渲染一致的"新的在前"。
 */
function mergeMemos(localMemos, remoteMemos) {
  const keyOf = (m) => `${m?.tag || ''}|${String(m?.timestamp || '').slice(0, 10)}`
  const byKey = new Map()
  for (const m of Array.isArray(localMemos) ? localMemos : []) {
    if (!m || typeof m !== 'object') continue
    const k = keyOf(m)
    if (!byKey.has(k)) byKey.set(k, { ...m })
  }
  for (const r of Array.isArray(remoteMemos) ? remoteMemos : []) {
    if (!r || typeof r !== 'object') continue
    const k = keyOf(r)
    const existing = byKey.get(k)
    if (!existing) byKey.set(k, { ...r })
    else existing.content = mergeMemoContent(existing.content, r.content)
  }
  return [...byKey.values()].sort((x, y) =>
    String(y.timestamp || '').localeCompare(String(x.timestamp || ''))
  )
}

/**
 * 把当前内存中的"今日已完成"并入历史快照后再合并。
 * 关键：今日打勾只存在于内存（completedIds），history[today] 要到重置/归档时才更新，
 * 若直接用持久化的 history 合并，会把本机今天刚勾的状态当成"不存在"而丢失。
 */
function localHistoryWithToday() {
  const history = JSON.parse(JSON.stringify(getCompletionHistory() || {}))
  const todayStr = getTodayDateString()
  const todayIds = [...getCompletedIds()]
  const existing = history[todayStr]
  const existingIds = Array.isArray(existing?.completedIds) ? existing.completedIds : []
  history[todayStr] = {
    completedIds: [...new Set([...existingIds, ...todayIds])],
    totalTasks: typeof existing?.totalTasks === 'number' ? existing.totalTasks : null
  }
  return history
}

/**
 * 完成历史合并：按天取 completedIds 并集，totalTasks 本地优先。
 * 采用并集而非覆盖：宁可冲突时多保留一个"已勾选"，也不因另一台设备的旧快照
 * 把本机刚勾上的任务抹掉（这正是用户反馈的"撤销我的打勾"）。
 */
function mergeCompletionHistory(local, remote) {
  const out = {}
  const days = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})])
  for (const day of days) {
    const l = local?.[day]
    const r = remote?.[day]
    const localIds = Array.isArray(l?.completedIds) ? l.completedIds : []
    const remoteIds = Array.isArray(r?.completedIds) ? r.completedIds : []
    out[day] = {
      completedIds: [...new Set([...localIds, ...remoteIds])],
      totalTasks: typeof l?.totalTasks === 'number' ? l.totalTasks : (typeof r?.totalTasks === 'number' ? r.totalTasks : null)
    }
  }
  return out
}

/**
 * 列表合并（workflows / rotationRules / memoTags）：
 * 以远端为准，并保留仅存在于本机的新增项。
 * 冲突被检出意味着远端版本更新，因此同 id 项取远端，避免"本机旧副本把远端新编辑顶回去"；
 * 而仅本机存在的项（本机新加的任务 / 标签）必须保留，否则会被覆盖丢失。
 */
function mergeByIdPreferRemote(localList, remoteList) {
  const remote = Array.isArray(remoteList) ? remoteList : []
  const local = Array.isArray(localList) ? localList : []
  const remoteIds = new Set(remote.map((item) => item?.id))
  const out = [...remote]
  for (const item of local) {
    if (!item || item.id === undefined || item.id === null) continue
    if (remoteIds.has(item.id)) continue
    out.push(item)
  }
  return out
}

/**
 * 取两个合法日期字符串中较晚的一个；用于 lastResetDate，避免用旧日期触发重复的每日重置。
 */
function pickLaterDate(a, b) {
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  if (!isDate(a)) return isDate(b) ? b : ''
  if (!isDate(b)) return a
  return a >= b ? a : b
}

/**
 * 冲突合并：把云端快照合并进本地状态（而非覆盖），随后由调用方继续上传，使两端收敛。
 * 设计目标：本机尚未同步的编辑（尤其是刚添加的生词、刚勾上的任务）绝不丢失，
 * 同时保留云端其它设备的改动。
 *
 * 合并策略：
 *  - memos：按「标签 + 日期」逐词并集 —— 保命优先，绝不丢词
 *  - completionHistory：按天 completedIds 并集 —— 绝不丢勾选
 *  - workflows / rotationRules / memoTags：远端优先 + 保留本机独有项
 *  - userSettings / ankiExportSettings：远端优先（远端更新）
 *  - ankiSettings：保留本机（此路径不处理远端密文解密，避免把解密失败当空值覆盖）
 *  - lastResetDate：取较晚者
 *
 * 返回 applyImportedState 的结果 { ok:true } 或 { ok:false, reason }（失败已自动回滚）。
 */
function mergeRemoteIntoLocal(remoteData) {
  const merged = {
    workflows: mergeByIdPreferRemote(getWorkflows(), remoteData.workflows),
    rotationRules: mergeByIdPreferRemote(getRotationRules(), remoteData.rotationRules),
    memos: mergeMemos(getMemos(), remoteData.memos),
    completionHistory: mergeCompletionHistory(
      localHistoryWithToday(),
      normalizeCompletionHistory(remoteData.completionHistory)
    ),
    lastResetDate: pickLaterDate(getLastResetDate(), remoteData.lastResetDate),
    userSettings: { ...getUserSettings(), ...(remoteData.userSettings || {}) },
    ankiSettings: getAnkiSettings(),
    ankiExportSettings: { ...getAnkiExportSettings(), ...(remoteData.ankiExportSettings || {}) },
    memoTags: mergeByIdPreferRemote(getMemoTags(), remoteData.memoTags)
  }
  return applyImportedState(merged)
}

/**
 * 上传前冲突检测（内部版，必须在队列内调用）。
 *
 * 版本比对用 GitHub 返回的 updated_at：本地记录的是「上一次同步时服务端返回的
 * updated_at」，与本次 GET 到的 updated_at 比较。两端同为服务端时间且同为 UTC
 * ISO 格式，彻底规避设备时钟偏差 / 时区差异导致的误判。
 *
 * 检出冲突时不再"拉取覆盖本地"，而是把云端合并进本地（见 mergeRemoteIntoLocal），
 * 再让调用方基于合并结果继续上传：既不撤销本机刚做的编辑，也不覆盖云端其它设备的改动。
 *
 * 返回值语义（调用方必须区分）：
 *  - { merged: true }      检出云端更新，已合并进本地，调用方应继续上传
 *  - { conflict: false }   已确认无冲突，可安全覆盖
 *  - { checkFailed: true } 无法确认（网络 / 鉴权 / 字段缺失 / 远端解析或合并失败）
 *                          —— 绝不可当作「无冲突」，否则会盲目覆盖云端数据
 */
async function checkForGistConflictInternal() {
  if (!hasGistCredentials()) return { conflict: false }
  const settings = getGistSettings()
  const res = await gistApiRequest(`gists/${settings.gistId}`)
  if (!res.ok) {
    DBG('gist:conflict:check-failed', { status: res.status })
    return { conflict: false, checkFailed: true, status: res.status }
  }
  const gistUpdatedAt = res.data?.updated_at
  if (!gistUpdatedAt) {
    DBG('gist:conflict:check-failed', { reason: 'missing-updated_at' })
    return { conflict: false, checkFailed: true, status: res.status }
  }
  const lastSynced = getLastGistUpdatedAt()
  const remoteContent = res.data?.files?.[GIST_FILENAME]?.content

  // 需要合并的两种情况：
  //  1) 本地无基线（首次配置 / 启动拉取失败）且远端已有备份 —— 归属未知，合并而非覆盖；
  //  2) 服务端版本与本地基线不一致 —— 云端在本地最后一次同步后被其它设备改过。
  const baselineUnset = !lastSynced
  const needMerge = baselineUnset ? Boolean(remoteContent) : gistUpdatedAt !== lastSynced
  if (!needMerge) {
    if (baselineUnset) DBG('gist:conflict:baseline-unset:no-remote-backup', { gistUpdatedAt })
    return { conflict: false, baselineUnset, gistUpdatedAt }
  }

  DBG('gist:conflict:detected', { gistUpdatedAt, lastSynced, baselineUnset })
  let remoteData
  try {
    const parsed = JSON.parse(remoteContent)
    const validateErr = validateBackupPayload(parsed)
    if (validateErr) {
      DBG('gist:conflict:merge:invalid', { validateErr })
      return { conflict: false, checkFailed: true, reason: 'invalid-remote', gistUpdatedAt }
    }
    remoteData = parsed.data
  } catch (err) {
    DBG('gist:conflict:merge:parse-error', { err: String(err) })
    return { conflict: false, checkFailed: true, reason: 'parse-error', gistUpdatedAt }
  }

  let applied
  try {
    // mergeRemoteIntoLocal 内部含 UI 渲染与事务逻辑，异常可能冒泡到调用方 catch
    // 导致用户看到"上传失败{msg}"；这里兜底为 checkFailed，绝不抛出。
    applied = mergeRemoteIntoLocal(remoteData)
  } catch (err) {
    DBG('gist:conflict:merge:exception', { err: String(err) })
    return { conflict: false, checkFailed: true, reason: 'merge-exception', gistUpdatedAt }
  }
  if (!applied.ok) {
    DBG('gist:conflict:merge:apply-failed', { reason: applied.reason })
    return { conflict: false, checkFailed: true, reason: 'merge-failed', pullReason: applied.reason, gistUpdatedAt }
  }
  // 合并已把本地覆盖为「本地 ∪ 云端」，需把今日完成态从合并后的历史回填到内存
  restoreTodayCompletedFromHistory()
  renderAfterImport()
  DBG('gist:conflict:merged', { gistUpdatedAt })
  return { conflict: false, merged: true, gistUpdatedAt }
}

/**
 * 把当前数据推送到 Gist（覆盖原文件）。
 *  - API Key 以对称加密密文形式进入 Gist；未设置口令 / 加密不可用时仅省略 API Key，其余数据照常上传，绝不阻断。
 *  - notifyKeyOmitted=true（手动上传）：当 API Key 被省略时弹一条非阻断提示；自动上传传 false 以免反复弹窗。
 *  - 调用方负责先写入 input（saveGistSettingsFromInputs）
 *
 * 网络错误不做盲目重试：每次重试前必须重新检查远端并合并，避免 PATCH 后状态未知时覆盖其它设备的数据。
 */
export function uploadToGist({ notifyKeyOmitted = true } = {}) {
  return enqueueGistOperation(() => {
    if (notifyKeyOmitted && hasGistCredentials()) {
      gistChangeGeneration += 1
      setSharedGistDirty(true)
    }
    return uploadToGistInternal({ notifyKeyOmitted })
  })
}

async function uploadToGistInternal({ notifyKeyOmitted = true } = {}) {
  let indicatorShown = false
  try {
    if (!hasGistCredentials()) {
      showToast(I18N.toast.gist.needCredentials)
      return { ok: false, reason: 'no-credentials' }
    }
    // 有限重试：Gist 无原子条件写（If-Match），「读版本 → 合并 → 覆盖写」之间存在
    // 无法彻底消除的窗口（其它设备可能在 GET 与 PATCH 之间写入）。这里通过
    // 「PATCH 后回读校验 + 重试」收敛：若回读内容与本次上传不一致，说明期间有别的
    // 写入发生，则重新合并远端（把对方改动并入本地）后再次上传，最多 MAX_UPLOAD_ATTEMPTS 轮。
    for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
      const generationBeforeCheck = gistChangeGeneration
      // 冲突检测：云端若有本机未同步的更新，先把云端「合并」进本地（而非覆盖），
      // 再基于合并结果构建 payload 上传，确保本机刚做的编辑（生词 / 勾选）不被撤销。
      const conflict = await checkForGistConflictInternal()
      // 冲突检测无法完成时中止覆盖写：手动上传提示用户重试，自动上传静默跳过本轮。
      // 宁可这一轮不传（下次 persist* 会再次触发），也不能在云端状态未知时盲目覆盖。
      if (conflict.checkFailed) {
        DBG('gist:upload:blocked:check-failed', { reason: conflict.reason, pullReason: conflict.pullReason })
        if (notifyKeyOmitted) {
          const msg = (conflict.reason === 'merge-failed' || conflict.reason === 'pull-failed')
            ? I18N.toast.gist.conflictPullFailed
            : I18N.toast.gist.conflictCheckFailed
          showToast(msg)
        }
        return { ok: false, reason: 'conflict-check-failed' }
      }
      // 仅在首轮提示「已合并」：后续轮次是同一次用户操作内的重试，不必重复打扰。
      if (conflict.merged && attempt === 1 && notifyKeyOmitted) {
        DBG('gist:upload:merged', { gistUpdatedAt: conflict.gistUpdatedAt })
        showToast(I18N.toast.gist.conflictMerged)
      }
      if (gistChangeGeneration !== generationBeforeCheck) {
        DBG('gist:upload:local-changed-during-conflict-check', { attempt })
        continue
      }

      const genAtBuild = gistChangeGeneration
      const built = await buildExportPayload()
      if (gistChangeGeneration !== genAtBuild) {
        DBG('gist:upload:local-changed-during-build', { attempt })
        if (attempt >= MAX_UPLOAD_ATTEMPTS) {
          if (notifyKeyOmitted) showToast(I18N.toast.gist.uploadVerifyUnknown)
          return { ok: false, reason: 'local-changed-during-build' }
        }
        continue
      }
      if (!built.ok) {
        showToast(I18N.toast.backup.exportFailed)
        DBG('gist:upload:blocked', { reason: built.reason })
        return { ok: false, reason: built.reason }
      }
      const payload = built.payload
      // 上传内容以字符串形式保留：既要发给服务端，也要用于上传后逐字节比对。
      const content = JSON.stringify(payload, null, 2)
      const body = {
        description: 'NJW daily backup',
        files: { [GIST_FILENAME]: { content } }
      }
      showGistUploading()
      indicatorShown = true
      const settings = getGistSettings()
      const res = await gistApiRequest(`gists/${settings.gistId}`, {
        method: 'PATCH',
        body
      })
      if (!res.ok) {
        hideGistIndicator()
        indicatorShown = false
        const msg = gistErrorMessage(res, { kind: 'upload' })
        showToast(msg)
        DBG('gist:upload:fail', { status: res.status, body: res.rawText?.slice(0, 200) })
        return { ok: false, reason: 'http-error', status: res.status }
      }

      // 上传后回读校验：只有确认云端当前内容就是本次上传内容，才推进成功基线。
      // PATCH 成功但回读失败属于结果不确定，不能据 PATCH 响应推断后续没有其它设备覆盖。
      const verify = await gistApiRequest(`gists/${settings.gistId}`)
      const remoteContent = verify.ok ? verify.data?.files?.[GIST_FILENAME]?.content : null
      const verified = verify.ok && typeof remoteContent === 'string' && remoteContent === content
      if (verified) {
        // 成功路径由 showGistUploaded()/hideGistIndicator() 自行接管指示器的收起时机，
        // 置回 false 以免下方 finally 立即清理掉刚触发的「转圈→画勾」成功动画。
        indicatorShown = false
        if (built.keyOmitted && notifyKeyOmitted) {
          hideGistIndicator()
          showToast(t(I18N.toast.anki.keyOmittedUpload, { reason: keyOmitReasonText(built.keyOmitReason) }))
        } else {
          showGistUploaded()
        }
        // 只用回读确认的服务端版本推进基线，不回退到 PATCH 响应或旧基线。
        const uploadedVersion = verify.data?.updated_at || ''
        markGistSyncSuccess('upload', { gistUpdatedAt: uploadedVersion })
        DBG('gist:upload:ok', {
          status: res.status,
          attempt,
          keyOmitted: built.keyOmitted,
          omitReason: built.keyOmitReason,
          gistUpdatedAt: uploadedVersion
        })
        return {
          ok: true,
          keyOmitted: built.keyOmitted,
          fingerprint: stableFingerprint(payload),
          attempts: attempt
        }
      }

      // 未通过校验：内容不一致说明被其它写入覆盖；回读失败则结果不确定。
      // 两者都不能推进成功基线，但只有明确读到其它内容时才重试，避免网络故障时盲目再写。
      hideGistIndicator()
      indicatorShown = false
      if (!verify.ok) {
        DBG('gist:upload:verify-unknown', { status: verify.status })
        if (notifyKeyOmitted) showToast(I18N.toast.gist.uploadVerifyUnknown)
        return { ok: false, reason: 'verify-unknown', status: verify.status }
      }
      DBG('gist:upload:verify-mismatch', { attempt })
      if (attempt >= MAX_UPLOAD_ATTEMPTS) {
        if (notifyKeyOmitted) showToast(I18N.toast.gist.uploadVerifyFailed)
        return { ok: false, reason: 'verify-failed' }
      }
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
    }
    return { ok: false, reason: 'verify-failed' }
  } catch (err) {
    // 兜底：buildExportPayload / checkForGistConflict / 网络请求等任何同步/异步异常，
    // 保证指示器始终收起，避免卡在「上传中」，并让调用方感知失败。
    DBG('gist:upload:exception', String(err))
    errorHandler.handleError(err, {
      type: ErrorTypes.NETWORK,
      severity: ErrorSeverity.MEDIUM,
      source: 'gist.uploadToGist'
    })
    if (notifyKeyOmitted) showToast(t(I18N.toast.gist.uploadFailed, { msg: err.message || String(err) }))
    return { ok: false, reason: 'exception' }
  } finally {
    if (indicatorShown) hideGistIndicator()
  }
}

/**
 * 把 Gist 中的备份拉回来，应用到本地。
 *  - silent = true 时不弹任何中间提示（仅返回结果），供启动自动拉取使用
 *  - 拉取成功后会调用 applyImportedState 把数据装载到各 store 并刷新 UI
 *
 * 手动拉取（silent=false）会以云端覆盖本地：因此在应用覆盖前（且完成异步读取/解密后）检查本地
 * 变更代次并确认。确认框放在锁内会短暂阻塞其它同步操作，但只有在临界写入边界保持锁，才能确保检查
 * 与应用远端状态之间不会被另一个遵守同一 Web Lock 的标签页插入同步操作。
 */
export async function pullFromGist({ silent = false } = {}) {
  return enqueueGistOperation(() => pullFromGistInternal({ silent }))
}

async function pullFromGistInternal({ silent = false } = {}) {
  if (!hasGistCredentials()) {
    const msg = I18N.toast.gist.needCredentials
    if (!silent) showToast(msg)
    return { ok: false, reason: 'no-credentials', notify: msg }
  }
  if (!silent) showToast(I18N.toast.gist.pulling)
  const settings = getGistSettings()
  const res = await gistApiRequest(`gists/${settings.gistId}`, { method: 'GET' })
  if (!res.ok) {
    const msg = gistErrorMessage(res, { kind: 'pull' })
    if (!silent) showToast(msg)
    return { ok: false, reason: 'http-error', status: res.status, notify: msg }
  }
  const files = res.data?.files || {}
  // 只认约定的备份文件名，绝不再回落到「任意首个文件」。
  // Gist 里可能存在用户其它文件，回落到首个文件会把无关 JSON 当备份解析，
  // 甚至覆盖本地数据，后果不可控。
  const file = files[GIST_FILENAME]
  if (!file || !file.content) {
    const msg = I18N.toast.gist.noBackup
    if (!silent) showToast(msg)
    return { ok: false, reason: 'no-file', notify: msg }
  }
  let parsed
  try {
    parsed = JSON.parse(file.content)
  } catch {
    const msg = I18N.toast.gist.invalidJson
    if (!silent) showToast(msg)
    return { ok: false, reason: 'parse-error', notify: msg }
  }
  const validateErr = validateBackupPayload(parsed)
  if (validateErr) {
    if (!silent) showToast(validateErr)
    return { ok: false, reason: 'invalid-format', notify: validateErr }
  }

  // 解密 API Key 失败时不应用 Gist：保留远端密文并阻止整个拉取覆盖本地状态。
  // 当前设备可能缺少口令或不具备 Web Crypto，不能把“暂时不可解密”当成有效空 Key。
  let ankiIn = parsed.data.ankiSettings
  let preserveLocalAnkiSettings = false
  if (ankiIn && typeof ankiIn === 'object') {
    const normalizedIn = normalizeAnkiSettings(ankiIn)
    const localSettings = getAnkiSettings()
    const localProfiles = getAnkiProfiles()
    const localHasConfiguredProfile = localProfiles.some((profile) =>
      Boolean(profile.modelId || profile.apiKey || profile.apiKeyEncrypted)
    )

    const remoteHasProfiles = Array.isArray(ankiIn.profiles) && ankiIn.profiles.some((profile) =>
      profile && typeof profile === 'object' && !Array.isArray(profile)
    )
    const remoteLooksLikeLegacyProfile = ['apiType', 'baseUrl', 'modelId', 'apiKey', 'apiKeyEncrypted']
      .some((key) => Object.prototype.hasOwnProperty.call(ankiIn, key))

    if (!remoteHasProfiles && !remoteLooksLikeLegacyProfile && localHasConfiguredProfile) {
      preserveLocalAnkiSettings = true
      DBG('gist:pull:anki:preserve-local', { reason: 'remote-profiles-missing-or-empty' })
    }

    const anyEncrypted = normalizedIn.profiles.some((p) => p.apiKeyEncrypted)
    if (anyEncrypted) {
      const passphrase = getEffectivePassphrase()
      let failedCount = 0
      const localById = new Map(localProfiles.map((p) => [p.id, p]))
      for (const p of normalizedIn.profiles) {
        if (!p.apiKeyEncrypted) continue
        if (!passphrase) {
          failedCount += 1
          continue
        }
        try {
          p.apiKey = await decryptAnkiSecret(p.apiKeyEncrypted, passphrase)
        } catch (err) {
          failedCount += 1
          const cryptoDown = err && (err.code === 'crypto-unavailable' || err.message === 'crypto-unavailable')
          DBG('gist:pull:anki:decrypt:error', { profileId: p.id, reason: cryptoDown ? 'crypto-unavailable' : 'decrypt-error' })
          const localMatch = localById.get(p.id) || localProfiles.find((l) => l.name === p.name && l.apiType === p.apiType)
          if (localMatch?.apiKey) p.apiKey = localMatch.apiKey
        }
      }
      if (failedCount > 0) {
        DBG('gist:pull:anki:blocked', { failedCount, hasPassphrase: Boolean(passphrase) })
        if (!silent) showToast(I18N.toast.anki.ankiSyncBlocked)
        return { ok: false, reason: 'anki-sync-blocked', notify: I18N.toast.anki.ankiSyncBlocked }
      }
      parsed.data.ankiSettings = { ...normalizedIn }
    } else if (normalizedIn.profiles.some((p) => p.apiKey && !p.apiKeyEncrypted)) {
      if (!silent) showToast(I18N.toast.anki.plainApiKeyWarning)
      parsed.data.ankiSettings = { ...normalizedIn }
    }

    if (preserveLocalAnkiSettings) parsed.data.ankiSettings = localSettings
  }

  // 覆盖本地之前再次验证 dirty 状态。确认框期间、本次 GET / 解密等待期间都可能发生本地编辑；
  // 任何新编辑都使旧确认失效，必须中止，不能把用户确认解释为无限期授权覆盖未来改动。
  if (!silent && hasUnsyncedLocalChanges()) {
    const confirmed = await openConfirmDialog({
      title: I18N.toast.gist.pullOverwriteTitle,
      message: I18N.toast.gist.pullOverwriteMessage,
      confirmText: I18N.toast.gist.pullOverwriteConfirm
    })
    if (!confirmed || hasUnsyncedLocalChanges()) {
      showToast(I18N.toast.gist.pullCanceled)
      return { ok: false, reason: confirmed ? 'local-changed-after-confirm' : 'canceled' }
    }
  }

  const generationBeforeApply = gistChangeGeneration
  // 应用阶段挂起自动上传由 applyImportedState 内部自行 suspend/resume，
  // 此处不再重复嵌套，避免 resume 计数错配导致自动上传被永久挂起。
  // 云端可能仍是旧数组格式；统一清洗为新对象规范，避免 setCompletionHistory 后持久化结构不合法
  const applied = applyImportedState({
    workflows: parsed.data.workflows,
    rotationRules: parsed.data.rotationRules,
    memos: parsed.data.memos,
    completionHistory: normalizeCompletionHistory(parsed.data.completionHistory),
    lastResetDate: parsed.data.lastResetDate,
    userSettings: parsed.data.userSettings,
    ankiSettings: parsed.data.ankiSettings,
    ankiExportSettings: parsed.data.ankiExportSettings,
    memoTags: parsed.data.memoTags
  })

  // 事务式应用失败：已回滚内存与 localStorage，此处必须中止流程，
  // 不得刷新 UI、不得标记同步成功，否则用户会误以为拉取已生效。
  if (!applied.ok) {
    DBG('gist:pull:apply-failed', { reason: applied.reason })
    const msg = I18N.toast.gist.applyFailed
    if (!silent) showToast(msg)
    return { ok: false, reason: applied.reason, notify: msg }
  }

  // 今日打勾状态恢复：直接用云端 completionHistory[today] 覆盖本地完成态
  // 不走 checkDailyReset(force)，否则 archiveTodayToHistory 会把本地旧打勾状态
  // 并入刚拉取的云端历史，导致"取消打勾"无法跨设备同步
  restoreTodayCompletedFromHistory()

  renderWorkflow()
  renderMemos()
  updateMemoCounters()
  renderTagSelector()
  renderAnkiSettingsInputs()

  // 拉取已把本地覆盖为与云端一致，用本次 GET 到的服务端版本作为新基线：
  // 此后别的设备再改动，其 updated_at 必然与此值不同，可被精确识别。
  markGistSyncSuccess('pull', { gistUpdatedAt: res.data?.updated_at || '' })
  if (gistChangeGeneration === generationBeforeApply) clearLocalGistDirtyAfterPull()
  if (!silent) showToast(I18N.toast.gist.pulled)
  DBG('gist:pull:ok', { gistUpdatedAt: res.data?.updated_at || '' })
  return { ok: true }
}

/**
 * 去抖上传：所有 persist* 函数都会触发，延迟 1200ms 后再真正上传。
 *  - 凭证缺失时直接跳过
 *  - 存在明文 API Key 但会话无加密口令时静默跳过，防止自动上传反复弹窗（手动上传仍会提示）
 *  - 同一时刻只允许一个上传任务运行
 *  - 上传前仍校验服务端版本；本地指纹不能代替跨设备冲突检测
 *  - 变更代次（changeGeneration）：上传在途期间产生的新变更会触发补传，降低最后一次编辑未上传的风险
 */
let gistAutoUploadPending = null
let gistAutoUploadRunning = false
// 记录最近一次经回读确认的 Gist 文件内容指纹，供诊断和后续去重策略使用。
// 此值不能单独作为「本地已同步」依据；上传前仍执行服务端冲突检测。
let lastAutoUploadedContent = null
// 变更代次：每次 scheduleAutoUpload 自增。上传在途时若有新变更，
// 本轮结束后据此判断是否需要补传，避免"上传期间的最后一次编辑"永久丢失。
let gistChangeGeneration = 0
// 持久化标记在多个标签页间共享；成功上传不主动清除，避免覆盖其它标签页并发写入的 dirty。
let localGistDirty = false
const GIST_DIRTY_STORAGE_KEY = 'njs-workflow-gist-dirty'

function readSharedGistDirty() {
  try {
    return localStorage.getItem(GIST_DIRTY_STORAGE_KEY) === 'true'
  } catch (err) {
    DBG('gist:dirty:read-error', String(err))
    return localGistDirty
  }
}

function setSharedGistDirty(dirty) {
  localGistDirty = Boolean(dirty)
  if (!localGistDirty) return
  try {
    localStorage.setItem(GIST_DIRTY_STORAGE_KEY, 'true')
  } catch (err) {
    DBG('gist:dirty:write-error', String(err))
  }
}

function clearLocalGistDirtyAfterPull() {
  localGistDirty = false
  try {
    if (localStorage.getItem(GIST_DIRTY_STORAGE_KEY) === 'true') {
      DBG('gist:dirty:shared-retained-after-pull')
    }
  } catch (err) {
    DBG('gist:dirty:read-error', String(err))
  }
}

function hasUnsyncedLocalChanges() {
  return localGistDirty || readSharedGistDirty()
}

// 使用防抖优化的自动上传
const debouncedAutoUpload = debounce(async () => {
  // 已在途：仅登记代次变化，由在途任务结束后自行补传。
  // 不能在此直接 return 了事，否则上传期间发生的编辑会被永久丢弃。
  if (gistAutoUploadRunning) {
    gistAutoUploadPending = true
    return
  }
  gistAutoUploadRunning = true
  const generationAtStart = gistChangeGeneration
  try {
    const built = await buildExportPayload()
    if (built.ok) {
      // 内容指纹只用于减少重复请求，不证明构建期间及跨标签页没有新改动。
      const fingerprint = stableFingerprint(built.payload)
      const result = await uploadToGist({ notifyKeyOmitted: false })
      // 记录的是「实际写入云端」内容的指纹：若上传前发生了冲突合并，
      // 服务端保存的是合并后的内容，与合并前构建的 fingerprint 不同。
      // 必须用上传结果回传的 fingerprint，否则下次调度会误判为「有变更」而重复上传。
      if (result && result.ok) lastAutoUploadedContent = result.fingerprint || fingerprint
    }
  } catch (err) {
    // uploadToGist 内部已 try/catch 兜底；此处为极端异常的二次保险，避免未捕获 rejection。
    DBG('gist:auto-upload:exception', String(err))
    errorHandler.handleError(err, {
      type: ErrorTypes.NETWORK,
      severity: ErrorSeverity.LOW,
      source: 'gist.debouncedAutoUpload'
    })
  } finally {
    gistAutoUploadRunning = false
    // 补传判定：仅当上传期间确有新变更（代次前进）或运行期间收到过 pending 标记时才重排，
    // 否则会陷入"无变更也反复空转"的循环。
    const hasNewChange = gistChangeGeneration !== generationAtStart
    if (hasNewChange || gistAutoUploadPending) {
      gistAutoUploadPending = null
      DBG('gist:auto-upload:rerun', { changed: hasNewChange })
      scheduleAutoUpload()
    }
  }
}, 1200)

export function scheduleAutoUpload() {
  if (!hasGistCredentials()) return
  gistChangeGeneration += 1
  setSharedGistDirty(true)
  debouncedAutoUpload()
}

/**
 * 立即上传当前快照，用于用户点击“保存配置”这类明确动作。
 * 不走 1.2s 去抖，并保证即使内容未变也会给出成功反馈。
 */
export async function uploadGistNow() {
  if (!hasGistCredentials()) return
  gistChangeGeneration += 1
  setSharedGistDirty(true)
  debouncedAutoUpload.cancel()
  gistAutoUploadPending = false
  if (gistAutoUploadRunning) return
  gistAutoUploadRunning = true
  const generationAtStart = gistChangeGeneration
  try {
    const built = await buildExportPayload()
    if (built.ok) {
      const fingerprint = stableFingerprint(built.payload)
      const result = await uploadToGist({ notifyKeyOmitted: false })
      // 同 debouncedAutoUpload：优先记录实际上传内容的指纹（可能经过冲突合并）。
      if (result && result.ok) lastAutoUploadedContent = result.fingerprint || fingerprint
    }
  } catch (err) {
    DBG('gist:upload-now:exception', String(err))
    errorHandler.handleError(err, {
      type: ErrorTypes.NETWORK,
      severity: ErrorSeverity.LOW,
      source: 'gist.uploadGistNow'
    })
  } finally {
    gistAutoUploadRunning = false
    const hasNewChange = gistChangeGeneration !== generationAtStart
    if (hasNewChange || gistAutoUploadPending) {
      gistAutoUploadPending = false
      DBG('gist:upload-now:rerun', { changed: hasNewChange })
      scheduleAutoUpload()
    }
  }
}

registerAutoUploadHandler(scheduleAutoUpload)

/**
 * 取消待处理的自动上传（用于紧急情况）
 */
export function cancelPendingAutoUpload() {
  debouncedAutoUpload.cancel()
  gistAutoUploadPending = null
}

/**
 * 从输入框读取 token / gistId 并与当前设置合并，持久化。
 */
export function saveGistSettingsFromInputs() {
  const tokenEl = document.getElementById('gist-token-input')
  const idEl = document.getElementById('gist-id-input')
  const prev = getGistSettings()
  const next = normalizeGistSettings({
    ...prev,
    token: (tokenEl?.value || '').trim(),
    gistId: (idEl?.value || '').trim()
  })
  setGistSettings(next)
  const persisted = persistGistSettings()
  renderGistSettingsInputs()
  if (!persisted) {
    showToast(I18N.toast.gist.configSaveFailed)
    return
  }
  showToast(I18N.toast.gist.configSaved)
  if (!hasGistCredentials()) return
  // 保存配置是用户明确动作：只要凭据完整就立即上传一次，
  // 不依赖 token/gistId 是否变化，避免“保存成功但没看到上传动画”。
  const saveBtn = document.getElementById('btn-gist-save')
  if (saveBtn) {
    saveBtn.disabled = true
    saveBtn.classList.add('is-busy')
  }
  // fire-and-forget：保存按钮点击不需要等待上传完成。
  uploadGistNow().finally(() => {
    if (saveBtn) {
      saveBtn.disabled = false
      saveBtn.classList.remove('is-busy')
    }
  })
}

export function clearGistSettings() {
  const prev = getGistSettings()
  setGistSettings({ ...prev, token: '', gistId: '', lastSyncAction: '', lastSyncTime: '', lastGistUpdatedAt: '' })
  cancelPendingAutoUpload()
  const persisted = persistGistSettings()
  renderGistSettingsInputs()
  if (!persisted) {
    showToast(I18N.toast.gist.configSaveFailed)
  } else {
    showToast(I18N.toast.gist.configCleared)
  }
  DBG('gist:settings:cleared', { persisted })
}

/**
 * 把当前 gistSettings 写回到输入框，并渲染状态行文案。
 */
export function renderGistSettingsInputs() {
  const tokenEl = document.getElementById('gist-token-input')
  const idEl = document.getElementById('gist-id-input')
  const statusEl = document.getElementById('gist-status')
  const statusMetaEl = document.getElementById('gist-status-meta')
  const settings = getGistSettings()
  if (tokenEl) tokenEl.value = settings.token || ''
  if (idEl) idEl.value = settings.gistId || ''
  if (statusEl) {
    const ready = hasGistCredentials()
    statusEl.textContent = ready
      ? I18N.settings.gistStatusConfigured
      : I18N.settings.gistStatusNotConfigured
    statusEl.classList.toggle('is-ready', ready)
  }
  if (statusMetaEl) {
    const action = settings.lastSyncAction
    const time = settings.lastSyncTime
    if (action && time) {
      const label = action === 'upload' ? I18N.settings.lastUpload : action === 'pull' ? I18N.settings.lastPull : I18N.settings.lastSync
      statusMetaEl.textContent = `${label}：${time}`
      statusMetaEl.classList.add('is-record')
    } else {
      statusMetaEl.textContent = I18N.settings.noSyncRecord
      statusMetaEl.classList.remove('is-record')
    }
  }
}

/**
 * 同步进行中：禁用按钮 + 状态行显示"正在…"
 *  - 返回的 finishBusy 函数用于结束 busy 态
 *  - 凭证缺失时直接调用 finish 并返回 noop
 */
export function setGistBusy(action) {
  const statusEl = document.getElementById('gist-status')
  const statusMetaEl = document.getElementById('gist-status-meta')
  const uploadBtn = document.getElementById('btn-gist-upload')
  const pullBtn = document.getElementById('btn-gist-pull')
  const saveBtn = document.getElementById('btn-gist-save')

  const finishBusy = () => {
    if (uploadBtn) {
      uploadBtn.disabled = false
      uploadBtn.classList.remove('is-busy')
    }
    if (pullBtn) {
      pullBtn.disabled = false
      pullBtn.classList.remove('is-busy')
    }
    if (saveBtn) saveBtn.disabled = false
    renderGistSettingsInputs()
  }

  if (!hasGistCredentials()) {
    finishBusy()
    return finishBusy
  }

  if (uploadBtn) {
    uploadBtn.disabled = true
    uploadBtn.classList.toggle('is-busy', action === 'upload')
  }
  if (pullBtn) {
    pullBtn.disabled = true
    pullBtn.classList.toggle('is-busy', action === 'pull')
  }
  if (saveBtn) saveBtn.disabled = true
  if (statusEl) {
    statusEl.classList.remove('is-ready', 'is-error')
    statusEl.classList.add('is-syncing')
    statusEl.textContent = action === 'upload' ? I18N.toast.gist.uploading : I18N.toast.gist.pullingBusy
  }
  if (statusMetaEl) statusMetaEl.classList.remove('is-record')
  return finishBusy
}

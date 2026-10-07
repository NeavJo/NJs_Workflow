import { DBG } from '../core/debug.js'
import { showToast, showGistUploading, showGistUploaded, hideGistIndicator } from '../ui.js'
import { I18N, t } from '../locales.js'
import { debounce } from '../utils/throttle.js'
import {
  getGistSettings,
  setGistSettings,
  persistGistSettings,
  markGistSyncSuccess,
  getLastGistUpdatedAt,
  hasGistCredentials
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
import { setUserSettings, persistUserSettings, getUserSettings } from '../core/settings-store.js'
import { setAnkiSettings, persistAnkiSettings, getAnkiProfiles, getAnkiSettings } from '../anki/anki-store.js'
import { setAnkiExportSettings, persistAnkiExportSettings, getAnkiExportSettings } from '../anki/anki-export-store.js'
import { normalizeAnkiSettings } from '../config/storage-config.js'
import { renderAnkiSettingsInputs } from '../anki/anki-settings.js'
import { decryptAnkiSecret } from '../anki/anki-crypto.js'
import { getEffectivePassphrase } from '../anki/anki-passphrase.js'
import { registerAutoUploadHandler, suspendAutoUpload, resumeAutoUpload } from '../core/sync-hooks.js'

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
 */
let gistOperationChain = Promise.resolve()

function enqueueGistOperation(task) {
  const result = gistOperationChain.then(task, task)
  gistOperationChain = result.then(() => {}, () => {})
  return result
}

/**
 * 上传前冲突检测（内部版，必须在队列内调用）。
 *
 * 版本比对改用 GitHub 返回的 updated_at：本地记录的是「上一次同步时服务端返回的
 * updated_at」，与本次 GET 到的 updated_at 比较。两端同为服务端时间且同为 UTC
 * ISO 格式，彻底规避设备时钟偏差 / 时区差异导致的误判（此前用本地 lastSyncTime
 * 与 UTC 时间比较，跨时区时必然误判为「云端更新」）。
 *
 * 返回值语义（调用方必须区分）：
 *  - { conflict: true }    云端确有新数据，已自动拉取，调用方需中止上传
 *  - { conflict: false }   已确认无冲突，可安全覆盖
 *  - { checkFailed: true } 无法确认（网络 / 鉴权 / 字段缺失 / 拉取失败）
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
  const remoteHasBackup = Boolean(res.data?.files?.[GIST_FILENAME]?.content)

  // 本地尚无基线版本（例如首次配置、或启动拉取失败）：
  //  - 远端没有备份文件：不存在可被覆盖的数据，放行上传，成功后再建立基线
  //  - 远端已有备份：无法确认归属，先拉取一次，避免盲目覆盖其它设备的数据
  if (!lastSynced) {
    if (!remoteHasBackup) {
      DBG('gist:conflict:baseline-unset:no-remote-backup', { gistUpdatedAt })
      return { conflict: false, baselineUnset: true, gistUpdatedAt }
    }
    const pulled = await pullFromGistInternal({ silent: true })
    if (!pulled.ok) {
      DBG('gist:conflict:baseline-pull-failed', { reason: pulled.reason })
      return { conflict: false, checkFailed: true, reason: 'pull-failed', pullReason: pulled.reason }
    }
    DBG('gist:conflict:baseline-unset:remote-wins', { gistUpdatedAt })
    return { conflict: true, baselineUnset: true }
  }

  // 服务端版本与本地基线不一致 → 云端在本地最后一次同步之后被修改过
  if (gistUpdatedAt !== lastSynced) {
    DBG('gist:conflict:detected', { gistUpdatedAt, lastSynced })
    // pullFromGist 内部有 UI 渲染和事务逻辑，异常可能冒泡到调用方的 catch，
    // 导致用户看到"上传失败{msg}"。这里保护：拉取失败返回 checkFailed 而非抛出。
    const pulled = await pullFromGistInternal({ silent: true })
    if (!pulled.ok) {
      DBG('gist:conflict:pull-failed', { reason: pulled.reason })
      return { conflict: false, checkFailed: true, reason: 'pull-failed', pullReason: pulled.reason }
    }
    return { conflict: true }
  }
  return { conflict: false }
}

/**
 * 把当前数据推送到 Gist（覆盖原文件）。
 *  - API Key 以对称加密密文形式进入 Gist；未设置口令 / 加密不可用时仅省略 API Key，其余数据照常上传，绝不阻断。
 *  - notifyKeyOmitted=true（手动上传）：当 API Key 被省略时弹一条非阻断提示；自动上传传 false 以免反复弹窗。
 *  - 调用方负责先写入 input（saveGistSettingsFromInputs）
 *
 * 网络重试决策：本模块故意**不**将 Gist 请求接入 utils/network-utils 的 fetchWithRetry。
 * 理由：
 *  1. Gist 上传走 PATCH 覆盖写，且带「冲突检测」（checkForGistConflict）——自动重试可能在冲突被静默拉取后
 *     立即二次写同一份数据，造成版本冲突 / 多余 Gist revision；
 *  2. 自动上传路径已有 debounce + 互斥（gistAutoUploadRunning）+ skip-unchanged，数据未变不会重复发起；
 *  3. Gist 写操作天然幂等（同内容覆盖），失败一次不影响本地数据，下次 persist* 会重新触发自动上传；
 *  4. 手动上传/拉取由用户操作触发，重试意义有限且会反复弹 toast。
 * 因此网络错误直接吞掉并上报 errorHandler，由上层数据流在合适时机（用户编辑 / 手动点同步）重新上传。
 */
export function uploadToGist({ notifyKeyOmitted = true } = {}) {
  return enqueueGistOperation(() => uploadToGistInternal({ notifyKeyOmitted }))
}

async function uploadToGistInternal({ notifyKeyOmitted = true } = {}) {
  let indicatorShown = false
  try {
    if (!hasGistCredentials()) {
      showToast(I18N.toast.gist.needCredentials)
      return { ok: false, reason: 'no-credentials' }
    }
    const built = await buildExportPayload()
    if (!built.ok) {
      showToast(I18N.toast.backup.exportFailed)
      DBG('gist:upload:blocked', { reason: built.reason })
      return { ok: false, reason: built.reason }
    }
    const payload = built.payload
    const body = {
      description: 'NJW daily backup',
      files: { [GIST_FILENAME]: { content: JSON.stringify(payload, null, 2) } }
    }
    const conflict = await checkForGistConflictInternal()
    if (conflict.conflict) {
      DBG('gist:upload:blocked:conflict')
      showToast(t(I18N.toast.gist.conflictResolved))
      return { ok: false, reason: 'conflict-resolved' }
    }
    // 冲突检测无法完成时中止覆盖写：手动上传提示用户重试，自动上传静默跳过本轮。
    // 宁可这一轮不传（下次 persist* 会再次触发），也不能在云端状态未知时盲目覆盖。
    if (conflict.checkFailed) {
      DBG('gist:upload:blocked:check-failed', { reason: conflict.reason, pullReason: conflict.pullReason })
      if (notifyKeyOmitted) {
        const msg = conflict.reason === 'pull-failed'
          ? I18N.toast.gist.conflictPullFailed
          : I18N.toast.gist.conflictCheckFailed
        showToast(msg)
      }
      return { ok: false, reason: 'conflict-check-failed' }
    }
    showGistUploading()
    indicatorShown = true
    const settings = getGistSettings()
    const res = await gistApiRequest(`gists/${settings.gistId}`, {
      method: 'PATCH',
      body
    })
    if (res.ok) {
      // 成功路径由 showGistUploaded()/hideGistIndicator() 自行接管指示器的收起时机，
      // 置回 false 以免下方 finally 立即清理掉刚触发的「转圈→画勾」成功动画。
      indicatorShown = false
      if (built.keyOmitted && notifyKeyOmitted) {
        hideGistIndicator()
        showToast(t(I18N.toast.anki.keyOmittedUpload, { reason: keyOmitReasonText(built.keyOmitReason) }))
      } else {
        showGistUploaded()
      }
      // 用 PATCH 响应里的 updated_at 作为新基线：这是本次写入后服务端的真实版本，
      // 下次冲突检测以它比较即可精确识别「别的设备是否又改过」，不依赖设备时钟。
      // 响应偶发缺少该字段时退回冲突检测阶段已确认的版本（baselineUnset 场景下可能为空，
      // 此时下次上传会重新走一次安全检测，不会误覆盖）。
      const uploadedVersion = res.data?.updated_at || conflict.gistUpdatedAt || ''
      markGistSyncSuccess('upload', { gistUpdatedAt: uploadedVersion })
      DBG('gist:upload:ok', { status: res.status, keyOmitted: built.keyOmitted, omitReason: built.keyOmitReason, gistUpdatedAt: uploadedVersion })
      return { ok: true, keyOmitted: built.keyOmitted }
    }
    hideGistIndicator()
    const msg = gistErrorMessage(res, { kind: 'upload' })
    showToast(msg)
    DBG('gist:upload:fail', { status: res.status, body: res.rawText?.slice(0, 200) })
    return { ok: false, reason: 'http-error', status: res.status }
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
 */
export function pullFromGist({ silent = false } = {}) {
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
  if (!silent) showToast(I18N.toast.gist.pulled)
  DBG('gist:pull:ok', { gistUpdatedAt: res.data?.updated_at || '' })
  return { ok: true }
}

/**
 * 去抖上传：所有 persist* 函数都会触发，延迟 1200ms 后再真正上传。
 *  - 凭证缺失时直接跳过
 *  - 存在明文 API Key 但会话无加密口令时静默跳过，防止自动上传反复弹窗（手动上传仍会提示）
 *  - 同一时刻只允许一个上传任务运行
 *  - 内容未变（与上次成功上传一致）时直接跳过，避免冗余网络请求与多余 Gist revision
 *  - 变更代次（changeGeneration）：上传在途期间产生的新变更不会被丢弃，
 *    本轮结束后若代次已前进则自动补传一次，保证"最后一次编辑"一定被同步
 */
let gistAutoUploadPending = null
let gistAutoUploadRunning = false
// 记录上一次成功自动上传的 Gist 文件内容（PATCH body 的 GIST_FILENAME content）。
// 自动上传前若当前内容与此完全一致则直接跳过，避免数据未变时的冗余网络请求与 Gist 版本变更。
let lastAutoUploadedContent = null
// 变更代次：每次 scheduleAutoUpload 自增。上传在途时若有新变更，
// 本轮结束后据此判断是否需要补传，避免"上传期间的最后一次编辑"永久丢失。
let gistChangeGeneration = 0

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
      // 注意：payload.exportTime 每次构建都会变化，参与比较会导致 skip 永远不命中，
      // 因此指纹只取稳定业务数据 + 版本，排除时间戳字段。
      const fingerprint = JSON.stringify({
        version: built.payload.version,
        data: built.payload.data
      })
      if (lastAutoUploadedContent !== null && fingerprint === lastAutoUploadedContent) {
        DBG('gist:auto-upload:skip-unchanged')
        return
      }
      const result = await uploadToGist({ notifyKeyOmitted: false })
      if (result && result.ok) lastAutoUploadedContent = fingerprint
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
  debouncedAutoUpload()
}

/**
 * 立即上传当前快照，用于用户点击“保存配置”这类明确动作。
 * 不走 1.2s 去抖，并保证即使内容未变也会给出成功反馈。
 */
export async function uploadGistNow() {
  if (!hasGistCredentials()) return
  gistChangeGeneration += 1
  debouncedAutoUpload.cancel()
  gistAutoUploadPending = false
  if (gistAutoUploadRunning) return
  gistAutoUploadRunning = true
  const generationAtStart = gistChangeGeneration
  try {
    const built = await buildExportPayload()
    if (built.ok) {
      const fingerprint = JSON.stringify({
        version: built.payload.version,
        data: built.payload.data
      })
      if (lastAutoUploadedContent !== null && fingerprint === lastAutoUploadedContent) {
        DBG('gist:upload-now:skip-unchanged')
        showGistUploading()
        showGistUploaded()
        return
      }
      const result = await uploadToGist({ notifyKeyOmitted: false })
      if (result && result.ok) lastAutoUploadedContent = fingerprint
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

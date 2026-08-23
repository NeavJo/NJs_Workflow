import { DBG } from '../core/debug.js'
import { showToast, showGistUploading, showGistUploaded, hideGistIndicator } from '../ui.js'
import { I18N, t } from '../locales.js'
import { debounce } from '../utils/throttle.js'
import {
  getGistSettings,
  setGistSettings,
  persistGistSettings,
  markGistSyncSuccess,
  hasGistCredentials
} from '../core/settings-store.js'
import { normalizeGistSettings } from '../config/storage-config.js'
import { gistApiRequest, gistErrorMessage, GIST_FILENAME } from './gist-api.js'
import { buildExportPayload, keyOmitReasonText } from './snapshot.js'
import { validateBackupPayload } from './json.js'
import { renderWorkflow } from '../workflow/workflow-renderer.js'
import { renderMemos, updateMemoCounters, renderTagSelector } from '../memo/memo-renderer.js'
import {
  setCompletionHistory,
  setLastResetDate,
  persistCompletionHistory,
  persistLastResetDate,
  restoreTodayCompletedFromHistory
} from '../workflow/history-store.js'
import {
  setWorkflows,
  persistWorkflows
} from '../workflow/workflow-store.js'
import { setRotationRules, persistRotationRules } from '../workflow/rotation-store.js'
import { replaceMemos, persistMemos, setMemoTags, persistMemoTags } from '../memo/memo-store.js'
import { setUserSettings, persistUserSettings } from '../core/settings-store.js'
import { setAnkiSettings, persistAnkiSettings, getAnkiSettings } from '../anki/anki-store.js'
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
function applyImportedState({ workflows, rotationRules, memos, completionHistory, lastResetDate, userSettings, ankiSettings, memoTags }) {
  suspendAutoUpload()
  try {
    setWorkflows(workflows)
    setRotationRules(rotationRules)
    replaceMemos(memos)
    setCompletionHistory(completionHistory)
    if (typeof lastResetDate === 'string') setLastResetDate(lastResetDate)
    if (userSettings) setUserSettings(userSettings)
    if (ankiSettings) setAnkiSettings(ankiSettings)
    if (Array.isArray(memoTags)) setMemoTags(memoTags)
    persistWorkflows()
    persistRotationRules()
    persistMemos()
    persistCompletionHistory()
    persistLastResetDate()
    persistUserSettings()
    if (ankiSettings) persistAnkiSettings()
    if (Array.isArray(memoTags)) persistMemoTags()
  } finally {
    resumeAutoUpload()
  }
  DBG('gist-pull:applied', {
    workflows: workflows.length,
    rotationRules: rotationRules.length,
    memos: memos.length,
    historyDays: Object.keys(completionHistory).length,
    hasAnkiKey: Boolean(ankiSettings && ankiSettings.apiKey),
    memoTags: Array.isArray(memoTags) ? memoTags.length : 0
  })
}

/**
 * 把当前数据推送到 Gist（覆盖原文件）。
 *  - API Key 以对称加密密文形式进入 Gist；未设置口令 / 加密不可用时仅省略 API Key，其余数据照常上传，绝不阻断。
 *  - notifyKeyOmitted=true（手动上传）：当 API Key 被省略时弹一条非阻断提示；自动上传传 false 以免反复弹窗。
 *  - 调用方负责先写入 input（saveGistSettingsFromInputs）
 */
export async function uploadToGist({ notifyKeyOmitted = true } = {}) {
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
  showGistUploading()
  const settings = getGistSettings()
  const res = await gistApiRequest(`gists/${settings.gistId}`, {
    method: 'PATCH',
    body
  })
  if (res.ok) {
    if (built.keyOmitted && notifyKeyOmitted) {
      hideGistIndicator()
      showToast(t(I18N.toast.anki.keyOmittedUpload, { reason: keyOmitReasonText(built.keyOmitReason) }))
    } else {
      showGistUploaded()
    }
    markGistSyncSuccess('upload')
    DBG('gist:upload:ok', { status: res.status, keyOmitted: built.keyOmitted, omitReason: built.keyOmitReason })
    return { ok: true, keyOmitted: built.keyOmitted }
  }
  hideGistIndicator()
  const msg = gistErrorMessage(res, { kind: 'upload' })
  showToast(msg)
  DBG('gist:upload:fail', { status: res.status, body: res.rawText?.slice(0, 200) })
  return { ok: false, reason: 'http-error', status: res.status }
}

/**
 * 把 Gist 中的备份拉回来，应用到本地。
 *  - silent = true 时不弹任何中间提示（仅返回结果），供启动自动拉取使用
 *  - 拉取成功后会调用 applyImportedState 把数据装载到各 store 并刷新 UI
 */
export async function pullFromGist({ silent = false } = {}) {
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
  const file = files[GIST_FILENAME] || Object.values(files)[0]
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

  // 解密加密的 API Key：口令缺失 / 解密失败时不阻断拉取——保留本地 apiKey，丢弃无法解密的密文，
  // 其余 Anki 字段照常同步，并以非阻断提示告知用户。
  const ankiIn = parsed.data.ankiSettings
  if (ankiIn && typeof ankiIn === 'object' && ankiIn.apiKeyEncrypted) {
    const passphrase = getEffectivePassphrase()
    let ankiKeyOmitReason = null
    if (!passphrase) {
      ankiKeyOmitReason = 'no-passphrase'
      DBG('gist:pull:anki-key:skip', { reason: 'no-passphrase', preservedLocalKey: Boolean(getAnkiSettings().apiKey) })
    } else {
      try {
        ankiIn.apiKey = await decryptAnkiSecret(ankiIn.apiKeyEncrypted, passphrase)
      } catch (err) {
        const cryptoDown = err && (err.code === 'crypto-unavailable' || err.message === 'crypto-unavailable')
        ankiKeyOmitReason = cryptoDown ? 'crypto-unavailable' : 'decrypt-error'
        DBG('gist:pull:decrypt:error', { reason: ankiKeyOmitReason, name: err?.name, message: err?.message })
      }
    }
    if (ankiKeyOmitReason) {
      const localKey = getAnkiSettings().apiKey
      if (localKey) ankiIn.apiKey = localKey
      ankiIn.apiKeyEncrypted = ''
      if (!silent) showToast(t(I18N.toast.anki.keyOmittedPull, { reason: keyOmitReasonText(ankiKeyOmitReason) }))
    }
  } else if (ankiIn && typeof ankiIn === 'object' && ankiIn.apiKey && !ankiIn.apiKeyEncrypted) {
    if (!silent) showToast(I18N.toast.anki.plainApiKeyWarning)
  }

  // 应用到各 store + 重新渲染
  // 注意：实际写入由 backup/events.js 在用户确认后调用 persistBackupToStorage
  // 这里只把内存中的引用同步好
  // 整个应用阶段挂起自动上传：拉取刚把云端数据写到本地，
  // 期间触发的 persist* 不应立刻把同一份数据反向传回 Gist。
  suspendAutoUpload()
  try {
    applyImportedState({
      workflows: parsed.data.workflows,
      rotationRules: parsed.data.rotationRules,
      memos: parsed.data.memos,
      completionHistory: parsed.data.completionHistory,
      lastResetDate: parsed.data.lastResetDate,
      userSettings: parsed.data.userSettings,
      ankiSettings: parsed.data.ankiSettings,
      memoTags: parsed.data.memoTags
    })

    // 今日打勾状态恢复：直接用云端 completionHistory[today] 覆盖本地完成态
    // 不走 checkDailyReset(force)，否则 archiveTodayToHistory 会把本地旧打勾状态
    // 并入刚拉取的云端历史，导致"取消打勾"无法跨设备同步
    restoreTodayCompletedFromHistory()

    renderWorkflow()
    renderMemos()
    updateMemoCounters()
    renderTagSelector()
    renderAnkiSettingsInputs()
  } finally {
    resumeAutoUpload()
  }

  markGistSyncSuccess('pull')
  if (!silent) showToast(I18N.toast.gist.pulled)
  DBG('gist:pull:ok')
  return { ok: true }
}

/**
 * 去抖上传：所有 persist* 函数都会触发，延迟 1200ms 后再真正上传。
 *  - 凭证缺失时直接跳过
 *  - 存在明文 API Key 但会话无加密口令时静默跳过，防止自动上传反复弹窗（手动上传仍会提示）
 *  - 同一时刻只允许一个上传任务运行
 */
let gistAutoUploadPending = null
let gistAutoUploadRunning = false

// 使用防抖优化的自动上传
const debouncedAutoUpload = debounce(async () => {
  if (gistAutoUploadRunning) return
  gistAutoUploadRunning = true
  try {
    await uploadToGist({ notifyKeyOmitted: false })
  } finally {
    gistAutoUploadRunning = false
  }
}, 1200)

export function scheduleAutoUpload() {
  if (!hasGistCredentials()) return
  debouncedAutoUpload()
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
  const changed = prev.token !== next.token || prev.gistId !== next.gistId
  setGistSettings(next)
  const persisted = persistGistSettings()
  renderGistSettingsInputs()
  if (!persisted) {
    showToast(I18N.toast.gist.configSaveFailed)
  } else if (changed) {
    showToast(I18N.toast.gist.configSaved)
  }
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

import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import {
  getGistSettings,
  setGistSettings,
  persistGistSettings,
  markGistSyncSuccess,
  hasGistCredentials
} from '../core/settings-store.js'
import { normalizeGistSettings } from '../config/storage-config.js'
import { gistApiRequest, gistErrorMessage, GIST_FILENAME } from './gist-api.js'
import { buildExportPayload } from './snapshot.js'
import { validateBackupPayload } from './json.js'
import { renderWorkflow } from '../workflow/workflow-renderer.js'
import { renderMemos, updateMemoCounters, renderTagSelector } from '../memo/memo-renderer.js'
import {
  setCompletionHistory,
  setLastResetDate,
  persistCompletionHistory,
  persistLastResetDate,
  checkDailyReset,
  restoreTodayCompletedFromHistory
} from '../workflow/history-store.js'
import {
  setWorkflows,
  persistWorkflows
} from '../workflow/workflow-store.js'
import { setRotationRules, persistRotationRules } from '../workflow/rotation-store.js'
import { replaceMemos, persistMemos } from '../memo/memo-store.js'
import { setUserSettings, persistUserSettings } from '../core/settings-store.js'
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
function applyImportedState({ workflows, rotationRules, memos, completionHistory, lastResetDate, userSettings }) {
  suspendAutoUpload()
  try {
    setWorkflows(workflows)
    setRotationRules(rotationRules)
    replaceMemos(memos)
    setCompletionHistory(completionHistory)
    if (typeof lastResetDate === 'string') setLastResetDate(lastResetDate)
    if (userSettings) setUserSettings(userSettings)
    persistWorkflows()
    persistRotationRules()
    persistMemos()
    persistCompletionHistory()
    persistLastResetDate()
    persistUserSettings()
  } finally {
    resumeAutoUpload()
  }
  DBG('gist-pull:applied', {
    workflows: workflows.length,
    rotationRules: rotationRules.length,
    memos: memos.length,
    historyDays: Object.keys(completionHistory).length
  })
}

/**
 * 把当前数据推送到 Gist（覆盖原文件）。
 *  - 调用方负责先写入 input（saveGistSettingsFromInputs）
 */
export async function uploadToGist() {
  if (!hasGistCredentials()) {
    showToast('请先填写 GitHub Token 与 Gist ID。')
    return { ok: false, reason: 'no-credentials' }
  }
  const payload = buildExportPayload()
  const body = {
    description: 'NJW daily backup',
    files: { [GIST_FILENAME]: { content: JSON.stringify(payload, null, 2) } }
  }
  showToast('正在上传到 Gist…')
  const settings = getGistSettings()
  const res = await gistApiRequest(`gists/${settings.gistId}`, {
    method: 'PATCH',
    body
  })
  if (res.ok) {
    showToast('已上传到 Gist。')
    markGistSyncSuccess('upload')
    DBG('gist:upload:ok', { status: res.status })
    return { ok: true }
  }
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
    const msg = '请先填写 GitHub Token 与 Gist ID。'
    if (!silent) showToast(msg)
    return { ok: false, reason: 'no-credentials', notify: msg }
  }
  if (!silent) showToast('正在从 Gist 拉取备份…')
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
    const msg = 'Gist 中找不到备份文件。'
    if (!silent) showToast(msg)
    return { ok: false, reason: 'no-file', notify: msg }
  }
  let parsed
  try {
    parsed = JSON.parse(file.content)
  } catch {
    const msg = 'Gist 文件不是合法的 JSON。'
    if (!silent) showToast(msg)
    return { ok: false, reason: 'parse-error', notify: msg }
  }
  const validateErr = validateBackupPayload(parsed)
  if (validateErr) {
    if (!silent) showToast(validateErr)
    return { ok: false, reason: 'invalid-format', notify: validateErr }
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
      userSettings: parsed.data.userSettings
    })

    // 跨天判断 + 今日打勾状态恢复
    checkDailyReset({ force: true, reason: 'gist-pull' })
    restoreTodayCompletedFromHistory()

    renderWorkflow()
    renderMemos()
    updateMemoCounters()
    renderTagSelector()
  } finally {
    resumeAutoUpload()
  }

  markGistSyncSuccess('pull')
  if (!silent) showToast('已从 Gist 拉取并覆盖本地数据。')
  DBG('gist:pull:ok')
  return { ok: true }
}

/**
 * 去抖上传：所有 persist* 函数都会触发，延迟 1200ms 后再真正上传。
 *  - 凭证缺失时直接跳过
 *  - 同一时刻只允许一个上传任务运行
 */
let gistAutoUploadPending = null
let gistAutoUploadRunning = false

export function scheduleAutoUpload() {
  if (!hasGistCredentials()) return
  if (gistAutoUploadPending) clearTimeout(gistAutoUploadPending)
  gistAutoUploadPending = setTimeout(async () => {
    gistAutoUploadPending = null
    if (gistAutoUploadRunning) return
    gistAutoUploadRunning = true
    try {
      await uploadToGist()
    } finally {
      gistAutoUploadRunning = false
    }
  }, 1200)
}

registerAutoUploadHandler(scheduleAutoUpload)

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
    showToast('Gist 配置保存失败，请检查浏览器存储权限。')
  } else if (changed) {
    showToast('Gist 同步配置已保存。')
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
      ? '已配置：启动时自动拉取，数据变更后自动推送。'
      : '未配置：请填写 GitHub Token 与 Gist ID。'
    statusEl.classList.toggle('is-ready', ready)
  }
  if (statusMetaEl) {
    const action = settings.lastSyncAction
    const time = settings.lastSyncTime
    if (action && time) {
      const label = action === 'upload' ? '最近上传' : action === 'pull' ? '最近拉取' : '最近同步'
      statusMetaEl.textContent = `${label}：${time}`
      statusMetaEl.classList.add('is-record')
    } else {
      statusMetaEl.textContent = '暂无同步记录'
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
    statusEl.textContent = action === 'upload' ? '正在上传到 Gist…' : '正在从 Gist 拉取…'
  }
  if (statusMetaEl) statusMetaEl.classList.remove('is-record')
  return finishBusy
}

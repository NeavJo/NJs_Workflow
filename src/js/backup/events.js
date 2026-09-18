import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N, t } from '../locales.js'
import {
  setWorkflows,
  resetToDefaults,
  persistWorkflows,
  getWorkflows
} from '../workflow/workflow-store.js'
import { setRotationRules, persistRotationRules } from '../workflow/rotation-store.js'
import { replaceMemos, persistMemos, getMemos } from '../memo/memo-store.js'
import {
  setCompletionHistory,
  setLastResetDate,
  persistCompletionHistory,
  persistLastResetDate,
  checkDailyReset,
  restoreTodayCompletedFromHistory
} from '../workflow/history-store.js'
import { setUserSettings, persistUserSettings, getUserSettings } from '../core/settings-store.js'
import { setAnkiSettings, persistAnkiSettings } from '../anki/anki-store.js'
import { decryptAnkiSecret } from '../anki/anki-crypto.js'
import { setPassphrase } from '../anki/anki-passphrase.js'
import { renderAnkiSettingsInputs } from '../anki/anki-settings.js'
import { renderWorkflow } from '../workflow/workflow-renderer.js'
import { renderMemos, updateMemoCounters, renderTagSelector } from '../memo/memo-renderer.js'
import { renderEditorList } from '../settings/workflow-editor.js'
import { exportBackup, readFileAsText } from './snapshot.js'
import { validateBackupPayload, persistBackupToStorage } from './json.js'
import {
  uploadToGist,
  pullFromGist,
  saveGistSettingsFromInputs,
  renderGistSettingsInputs,
  setGistBusy
} from './gist-sync.js'
import { renderDailyResetStatus, bindDailyResetEvents } from './daily-reset.js'
import { registerBackupEvents } from '../settings/index.js'

/**
 * 备份域事件绑定 + 文件导入流程：
 *  - 导出按钮 / 重置默认按钮
 *  - Gist 输入框 + 保存 / 上传 / 拉取按钮
 *  - Drop Zone（拖拽 / 点击文件选择）
 *  - 每日重置按钮
 *  - 切换到 backup 子页面时刷新一次状态文案
 */

/**
 * 由 settings/index.js 通过 registerBackupEvents(fn) 注入的调用入口。
 * 实际绑定全部由该函数完成，保持 settings 与 backup 模块解耦。
 */
export function bindBackupEvents() {
  const exportBtn = document.getElementById('btn-export')
  const resetBtn = document.getElementById('btn-reset-workflows')
  if (exportBtn) exportBtn.addEventListener('click', exportBackup)
  if (resetBtn) resetBtn.addEventListener('click', resetWorkflowsToDefault)

  bindGistSettingsEvents()
  bindDailyResetEvents()
  bindDropZone()

  document.querySelectorAll('.view--settings [data-settings-page]').forEach((item) => {
    // 幂等守卫：防止与 settings/index.js / daily-reset.js 的重复绑定累积多个监听器。
    if (item.dataset.bound === '1') return
    item.dataset.bound = '1'
    item.addEventListener('click', () => {
      if (item.dataset.settingsPage === 'backup') {
        renderGistSettingsInputs()
        renderDailyResetStatus()
      }
    })
  })
}

/**
 * 重置工作流为默认任务列表。
 *  - 仅清空 workflows key；rotationRules / completed / memos 不动
 *  - 复用 workflow-store 的 resetToDefaults
 */
function resetWorkflowsToDefault() {
  if (!confirm(I18N.toast.backup.resetToDefaultConfirm)) return
  resetToDefaults()
  renderWorkflow()
  renderEditorList()
  showToast(I18N.toast.backup.resetToDefaultDone)
}

/* ====================================================================
 * Gist 输入/按钮绑定
 * ==================================================================== */

function bindGistSettingsEvents() {
  const tokenEl = document.getElementById('gist-token-input')
  const idEl = document.getElementById('gist-id-input')
  const saveBtn = document.getElementById('btn-gist-save')
  const uploadBtn = document.getElementById('btn-gist-upload')
  const pullBtn = document.getElementById('btn-gist-pull')

  if (tokenEl) tokenEl.addEventListener('blur', saveGistSettingsFromInputs)
  if (idEl) idEl.addEventListener('blur', saveGistSettingsFromInputs)
  if (saveBtn) saveBtn.addEventListener('click', saveGistSettingsFromInputs)
  if (uploadBtn) {
    uploadBtn.addEventListener('click', async () => {
      saveGistSettingsFromInputs()
      const finishBusy = setGistBusy('upload')
      try {
        await uploadToGist()
      } catch (err) {
        DBG('gist:upload:exception', String(err))
        showToast(t(I18N.toast.gist.uploadFailed, { msg: err?.message || I18N.toast.gist.unknownError }))
      } finally {
        finishBusy()
      }
    })
  }
  if (pullBtn) {
    pullBtn.addEventListener('click', async () => {
      saveGistSettingsFromInputs()
      const finishBusy = setGistBusy('pull')
      try {
        await pullFromGist()
      } catch (err) {
        DBG('gist:pull:exception', String(err))
        showToast(t(I18N.toast.gist.pullFailed, { msg: err?.message || I18N.toast.gist.unknownError }))
      } finally {
        finishBusy()
      }
    })
  }
}

/* ====================================================================
 * 文件导入 / Drop Zone
 * ==================================================================== */

async function handleImportFile(file) {
  if (!file) return
  const name = file.name.toLowerCase()
  if (!name.endsWith('.json') && file.type !== 'application/json' && file.type !== '') {
    showToast(I18N.toast.backup.jsonOnly)
    return
  }
  let parsed
  try {
    parsed = JSON.parse(await readFileAsText(file))
  } catch {
    showToast(I18N.toast.backup.jsonParseFailed)
    return
  }
  const err = validateBackupPayload(parsed)
  if (err) { showToast(err); return }

  // 解密加密的 API Key（若有）：口令缺失 / 错误 / 数据损坏时中止导入，不污染本地配置。
  const ankiIn = parsed.data.ankiSettings
  if (ankiIn && typeof ankiIn === 'object' && ankiIn.apiKeyEncrypted) {
    const passphrase = window.prompt(I18N.toast.anki.importPassphrasePrompt)
    if (passphrase == null) {
      showToast(I18N.toast.backup.importCancelled)
      return
    }
    try {
      ankiIn.apiKey = await decryptAnkiSecret(ankiIn.apiKeyEncrypted, passphrase)
      setPassphrase(passphrase)
    } catch (err) {
      const cryptoDown = err && (err.code === 'crypto-unavailable' || err.message === 'crypto-unavailable')
      DBG('import:anki:decrypt:error', {
        reason: cryptoDown ? 'crypto-unavailable' : 'decrypt-error',
        name: err?.name,
        message: err?.message
      })
      showToast(cryptoDown ? I18N.toast.anki.cryptoUnavailable : I18N.toast.anki.decryptFailed)
      return
    }
  } else if (ankiIn && typeof ankiIn === 'object' && ankiIn.apiKey && !ankiIn.apiKeyEncrypted) {
    showToast(I18N.toast.anki.plainApiKeyWarning)
  }

  const historyDays = parsed.data.completionHistory ? Object.keys(parsed.data.completionHistory).length : 0
  const historyLine = historyDays > 0 ? t(I18N.toast.backup.historyLine, { days: historyDays }) : ''
  const ankiLine = parsed.data.ankiSettings ? I18N.toast.backup.ankiLine : ''
  const confirmMsg = t(I18N.toast.backup.importConfirmMsg, {
    tasks: parsed.data.workflows.length,
    rules: Array.isArray(parsed.data.rotationRules) ? parsed.data.rotationRules.length : 0,
    notes: parsed.data.memos.length,
    historyLine,
    ankiLine,
    time: parsed.exportTime || I18N.toast.backup.unknown,
    version: parsed.version || I18N.toast.backup.unknown
  })
  if (!confirm(confirmMsg)) { showToast(I18N.toast.backup.importCancelled); return }

  const imported = persistBackupToStorage(parsed, { fallbackLastReset: '' })
  if (!imported) {
    showToast(I18N.toast.backup.storageWriteFailed)
    return
  }

  // 把数据同步到各 in-memory store 并刷新 UI
  setWorkflows(imported.workflows)
  setRotationRules(imported.rotationRules)
  replaceMemos(imported.memos)
  if (imported.completionHistory) setCompletionHistory(imported.completionHistory)
  if (typeof imported.lastResetDate === 'string') setLastResetDate(imported.lastResetDate)
  if (imported.userSettings) setUserSettings(imported.userSettings)
  if (imported.ankiSettings) setAnkiSettings(imported.ankiSettings)

  // 双保险：把每个 store 的 persist* 跑一遍，让内部状态与 localStorage 完全一致
  persistWorkflows()
  persistRotationRules()
  persistMemos()
  persistCompletionHistory()
  persistLastResetDate()
  persistUserSettings()
  if (imported.ankiSettings) persistAnkiSettings()

  // 跨天判断 + 今日打勾状态恢复（应用历史 today 列表）
  checkDailyReset({ force: true, reason: 'file-import' })
  restoreTodayCompletedFromHistory()

  // 触发 UI 刷新
  if (typeof getWorkflows === 'function') renderWorkflow()
  renderMemos()
  updateMemoCounters()
  renderTagSelector()
  renderEditorList()
  renderAnkiSettingsInputs()

  DBG('import:success', {
    workflows: getWorkflows().length,
    rotationRules: imported.rotationRules.length,
    memos: getMemos().length,
    historyDays: Object.keys(getCompletionHistory()).length,
    userSettingsKeys: Object.keys(getUserSettings()).length,
    hasAnkiKey: Boolean(imported.ankiSettings && imported.ankiSettings.apiKey)
  })
  showToast(t(I18N.toast.backup.importSuccess, {
    tasks: getWorkflows().length,
    rules: imported.rotationRules.length,
    notes: getMemos().length
  }))
}

function bindDropZone() {
  const drop = document.querySelector('.file-drop')
  if (!drop) return
  const input = document.getElementById('file-import')
  const hint = document.getElementById('file-drop-hint')
  const originalHint = hint ? hint.textContent : ''

  const activate = (e) => { e.preventDefault(); drop.classList.add('is-dragover') }
  const deactivate = (e) => { e.preventDefault(); drop.classList.remove('is-dragover') }

  drop.addEventListener('dragenter', activate)
  drop.addEventListener('dragover', activate)
  drop.addEventListener('dragleave', (e) => {
    if (!drop.contains(e.relatedTarget)) deactivate(e)
  })
  drop.addEventListener('drop', async (e) => {
    e.preventDefault()
    drop.classList.remove('is-dragover')
    const file = e.dataTransfer?.files?.[0]
    if (file) {
      if (hint) hint.textContent = t(I18N.toast.backup.fileRecognized, { name: file.name })
      await handleImportFile(file)
      setTimeout(() => { if (hint) hint.textContent = originalHint }, 1500)
    }
  })

  if (input) {
    input.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0]
      if (file && hint) hint.textContent = t(I18N.toast.backup.fileSelected, { name: file.name })
      await handleImportFile(file)
      e.target.value = ''
      setTimeout(() => { if (hint) hint.textContent = originalHint }, 1500)
    })
  }
}

/* ====================================================================
 * 启动注入：让 settings/index.js 能拿到本模块的事件绑定
 * ==================================================================== */

registerBackupEvents(bindBackupEvents)

// 导出供外部按需调用
export { handleImportFile }

/* 重置默认任务列表也对外暴露（Gist 同步 UI 的偶尔测试按钮可能用到） */
export { resetWorkflowsToDefault }



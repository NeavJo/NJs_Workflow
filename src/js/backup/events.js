import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import {
  setWorkflows,
  resetToDefaults,
  replaceAll as replaceAllWorkflows,
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
  if (!confirm('确认把任务列表恢复为出厂默认？\n\n* 仅重置 workflows 配置；\n* 轮换规则、打卡勾选与生词笔记不会被改动。')) return
  resetToDefaults()
  renderWorkflow()
  renderEditorList()
  showToast('已恢复默认任务列表。')
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
        showToast(`Gist 上传失败：${err?.message || '发生未知错误'}`)
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
        showToast(`Gist 拉取失败：${err?.message || '发生未知错误'}`)
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
    showToast('请选择 .json 格式的备份文件。')
    return
  }
  let parsed
  try {
    parsed = JSON.parse(await readFileAsText(file))
  } catch {
    showToast('JSON 解析失败，文件可能损坏。')
    return
  }
  const err = validateBackupPayload(parsed)
  if (err) { showToast(err); return }

  const historyDays = parsed.data.completionHistory ? Object.keys(parsed.data.completionHistory).length : 0
  const confirmMsg =
    `导入将覆盖当前设备的：\n` +
    `  · 任务配置列表（${parsed.data.workflows.length} 条）\n` +
    `  · 轮换规则（${Array.isArray(parsed.data.rotationRules) ? parsed.data.rotationRules.length : 0} 条）\n` +
    `  · 生词笔记（${parsed.data.memos.length} 条）\n` +
    (historyDays > 0 ? `  · 跨天打卡历史（${historyDays} 天）\n` : '') +
    `\n注意：今日打卡勾选状态将从备份中恢复（如存在）。\n\n` +
    `导出时间：${parsed.exportTime || '未知'}\n版本：${parsed.version || '未知'}\n\n确定继续吗？`
  if (!confirm(confirmMsg)) { showToast('已取消导入。'); return }

  const imported = persistBackupToStorage(parsed, { fallbackLastReset: '' })
  if (!imported) {
    showToast('写入 LocalStorage 失败，请检查浏览器存储权限。')
    return
  }

  // 把数据同步到各 in-memory store 并刷新 UI
  setWorkflows(imported.workflows)
  setRotationRules(imported.rotationRules)
  replaceMemos(imported.memos)
  if (imported.completionHistory) setCompletionHistory(imported.completionHistory)
  if (typeof imported.lastResetDate === 'string') setLastResetDate(imported.lastResetDate)
  if (imported.userSettings) setUserSettings(imported.userSettings)

  // 双保险：把每个 store 的 persist* 跑一遍，让内部状态与 localStorage 完全一致
  persistWorkflows()
  persistRotationRules()
  persistMemos()
  persistCompletionHistory()
  persistLastResetDate()
  persistUserSettings()

  // 跨天判断 + 今日打勾状态恢复（应用历史 today 列表）
  checkDailyReset({ force: true, reason: 'file-import' })
  restoreTodayCompletedFromHistory()

  // 触发 UI 刷新
  if (typeof getWorkflows === 'function') renderWorkflow()
  renderMemos()
  updateMemoCounters()
  renderTagSelector()
  renderEditorList()

  DBG('import:success', {
    workflows: getWorkflows().length,
    rotationRules: imported.rotationRules.length,
    memos: getMemos().length,
    historyDays: Object.keys(getCompletionHistory()).length,
    userSettingsKeys: Object.keys(getUserSettings()).length
  })
  showToast(`导入成功：${getWorkflows().length} 任务 / ${imported.rotationRules.length} 规则 / ${getMemos().length} 笔记。`)
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
      if (hint) hint.textContent = `已识别：${file.name}`
      await handleImportFile(file)
      setTimeout(() => { if (hint) hint.textContent = originalHint }, 1500)
    }
  })

  if (input) {
    input.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0]
      if (file && hint) hint.textContent = `已选择：${file.name}`
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

// 抑制 lint：未引用的 import 提示
void replaceAllWorkflows

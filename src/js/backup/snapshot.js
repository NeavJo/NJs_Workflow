import { DBG } from '../core/debug.js'
import { formatTimestamp } from '../core/date.js'
import { getWorkflows, serializeWorkflowArray } from '../workflow/workflow-store.js'
import { getRotationRules } from '../workflow/rotation-store.js'
import { getMemos } from '../memo/memo-store.js'
import { getCompletionHistory, getLastResetDate } from '../workflow/history-store.js'
import { getCompletedIds } from '../workflow/completion-store.js'
import { getUserSettings } from '../core/settings-store.js'
import { getTodayDateString } from '../core/date.js'
import { showToast } from '../ui.js'

/**
 * 备份快照 + 本地文件导出：
 *  - buildExportPayload：把全部 store 打包成 v1.2 格式 JSON
 *  - exportBackup：把快照写到 .json 文件并触发浏览器下载
 *  - triggerDownload / readFileAsText / formatTimestampForFilename：IO 工具
 */

export const BACKUP_VERSION = '1.2'

/**
 * 把 Date 转成 YYYYMMDD，用于生成下载文件名。
 */
export function formatTimestampForFilename(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/**
 * 在浏览器中触发 .json 文件下载。
 * 使用 Blob + 临时 <a> 标签；下载完成后释放 ObjectURL。
 */
export function triggerDownload(filename, text) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1200)
}

/**
 * 读取 File 为 utf-8 字符串。
 */
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('read-file-error'))
    reader.readAsText(file, 'utf-8')
  })
}

/**
 * v1.2 起包含 completionHistory / lastResetDate / userSettings，
 * 并把今日 completedItems 合并进 history[today] 以支持跨设备同步今日状态。
 */
export function buildExportPayload() {
  const workflowsSnapshot = serializeWorkflowArray(getWorkflows())
  const rotationSnapshot = JSON.parse(JSON.stringify(getRotationRules()))
  const memosSnapshot = getMemos().map((m) => ({
    id: m.id,
    timestamp: m.timestamp,
    tag: m.tag,
    content: m.content
  }))
  const completionHistorySnapshot = JSON.parse(JSON.stringify(getCompletionHistory()))
  completionHistorySnapshot[getTodayDateString()] = [...getCompletedIds()]
  const userSettingsSnapshot = { ...getUserSettings() }
  const lastReset = getLastResetDate()
  DBG('export:snapshot', {
    workflowsLength: workflowsSnapshot.length,
    rotationRulesLength: rotationSnapshot.length,
    memosLength: memosSnapshot.length,
    historyDays: Object.keys(completionHistorySnapshot).length,
    hasLastResetDate: Boolean(lastReset),
    userSettingsKeys: Object.keys(userSettingsSnapshot).length
  })
  return {
    version: BACKUP_VERSION,
    exportTime: formatTimestamp(new Date()),
    data: {
      workflows: workflowsSnapshot,
      rotationRules: rotationSnapshot,
      memos: memosSnapshot,
      completionHistory: completionHistorySnapshot,
      lastResetDate: lastReset,
      userSettings: userSettingsSnapshot
    }
  }
}

/**
 * 导出全部数据为 .json 文件并触发浏览器下载；UI 提示。
 */
export function exportBackup() {
  try {
    const payload = buildExportPayload()
    const now = new Date()
    const filename = `njw_backup_${formatTimestampForFilename(now)}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}.json`
    triggerDownload(filename, JSON.stringify(payload, null, 2))
    const workflows = getWorkflows()
    const rotationRules = getRotationRules()
    const memos = getMemos()
    showToast(`已生成备份文件（${workflows.length} 条任务 / ${rotationRules.length} 条轮换规则 / ${memos.length} 条笔记）并开始下载。`)
  } catch (e) {
    DBG('export:error', String(e?.stack || e))
    showToast('导出失败，请稍后重试。')
  }
}

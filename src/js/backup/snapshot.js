import { DBG } from '../core/debug.js'
import { formatTimestamp } from '../core/date.js'
import { I18N, t } from '../locales.js'
import { getWorkflows, serializeWorkflowArray } from '../workflow/workflow-store.js'
import { getRotationRules } from '../workflow/rotation-store.js'
import { getMemos } from '../memo/memo-store.js'
import { getCompletionHistory, getLastResetDate } from '../workflow/history-store.js'
import { getCompletedIds } from '../workflow/completion-store.js'
import { getUserSettings } from '../core/settings-store.js'
import { getAnkiSettings } from '../anki/anki-store.js'
import { getMemoTags } from '../memo/memo-store.js'

import { getTodayDateString } from '../core/date.js'
import { showToast } from '../ui.js'
import { encryptAnkiSecret } from '../anki/anki-crypto.js'
import { getEffectivePassphrase } from '../anki/anki-passphrase.js'

/**
 * 备份快照 + 本地文件导出：
 *  - buildExportPayload：把全部 store 打包成 v1.2 格式 JSON
 *  - exportBackup：把快照写到 .json 文件并触发浏览器下载
 *  - triggerDownload / readFileAsText / formatTimestampForFilename：IO 工具
 */

export const BACKUP_VERSION = '1.3'

/**
 * 把 Date 转成 YYYYMMDD，用于生成下载文件名。
 */
export function formatTimestampForFilename(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

/**
 * 在浏览器中触发文件下载。
 * 使用 Blob + 临时 <a> 标签；下载完成后释放 ObjectURL。
 *
 * @param {string} filename  - 下载文件名（含扩展名）
 * @param {string} text      - 文件内容
 * @param {string} [mimeType='application/json'] - Blob MIME 类型，默认 JSON；下载 .txt 时需显式传入 'text/plain;charset=utf-8'
 */
export function triggerDownload(filename, text, mimeType = 'application/json;charset=utf-8') {
  const blob = new Blob([text], { type: mimeType })
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
 * 把 Anki 配置转为可导出形态：
 *  - apiKey 非空且存在有效口令 → 现场加密为 apiKeyEncrypted，apiKey 置空后随备份/Gist 输出。
 *  - apiKey 非空但无口令 / 加密不可用 / 加密失败 → 省略 apiKey（置空），其余字段照常输出，绝不阻断同步。
 *  - 返回 { settings, keyOmitted, omitReason? }；omitReason ∈ 'no-passphrase' | 'crypto-unavailable' | 'encrypt-error'。
 */
async function prepareAnkiSettingsForExport(ankiSnapshot) {
  const snapshot = { ...ankiSnapshot, apiKeyEncrypted: ankiSnapshot.apiKeyEncrypted || '' }
  if (!snapshot.apiKey) {
    return { settings: { ...snapshot, apiKeyEncrypted: '' }, keyOmitted: false }
  }
  const passphrase = getEffectivePassphrase()
  if (!passphrase) {
    return { settings: { ...snapshot, apiKey: '', apiKeyEncrypted: '' }, keyOmitted: true, omitReason: 'no-passphrase' }
  }
  try {
    const encrypted = await encryptAnkiSecret(snapshot.apiKey, passphrase)
    return { settings: { ...snapshot, apiKey: '', apiKeyEncrypted: encrypted }, keyOmitted: false }
  } catch (err) {
    const reason = err && (err.code === 'crypto-unavailable' || err.message === 'crypto-unavailable')
      ? 'crypto-unavailable'
      : 'encrypt-error'
    DBG('export:anki:encrypt:error', {
      reason,
      name: err?.name,
      message: err?.message,
      stack: String(err?.stack || err).slice(0, 300)
    })
    return { settings: { ...snapshot, apiKey: '', apiKeyEncrypted: '' }, keyOmitted: true, omitReason: reason }
  }
}

/**
 * 把 omitReason 映射成给用户看的短文案，供上传 / 导出 / 拉取的非阻断提示复用。
 */
export function keyOmitReasonText(reason) {
  if (reason === 'no-passphrase') return I18N.toast.anki.keyOmitReasonNoPass
  if (reason === 'crypto-unavailable') return I18N.toast.anki.keyOmitReasonCrypto
  return I18N.toast.anki.keyOmitReasonError
}

/**
 * v1.2 起包含 completionHistory / lastResetDate / userSettings，
 * 并把今日 completedItems 合并进 history[today] 以支持跨设备同步今日状态。
 * 自 v1.3 起 API Key 以对称加密（apiKeyEncrypted）形式进入备份与 Gist；
 * 未设置口令 / 加密不可用时省略 API Key 但仍输出其余数据。
 * 返回 { ok:true, payload, keyOmitted, keyOmitReason }。
 */
export async function buildExportPayload() {
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
  const ankiSettingsSnapshot = { ...getAnkiSettings() }
  const memoTagsSnapshot = []
  try {
    const memoTags = getMemoTags()
    if (Array.isArray(memoTags)) {
      memoTagsSnapshot.push(...memoTags)
    }
  } catch (e) {
    DBG('export:memoTags:error', String(e))
  }
  const lastReset = getLastResetDate()
  const prepared = await prepareAnkiSettingsForExport(ankiSettingsSnapshot)
  DBG('export:snapshot', {
    workflowsLength: workflowsSnapshot.length,
    rotationRulesLength: rotationSnapshot.length,
    memosLength: memosSnapshot.length,
    historyDays: Object.keys(completionHistorySnapshot).length,
    hasLastResetDate: Boolean(lastReset),
    userSettingsKeys: Object.keys(userSettingsSnapshot).length,
    hasAnkiKey: Boolean(ankiSettingsSnapshot.apiKey),
    hasAnkiEncrypted: Boolean(prepared.settings.apiKeyEncrypted),
    ankiKeyOmitted: Boolean(prepared.keyOmitted),
    ankiOmitReason: prepared.omitReason || null
  })
  return {
    ok: true,
    payload: {
      version: BACKUP_VERSION,
      exportTime: formatTimestamp(new Date()),
      data: {
        workflows: workflowsSnapshot,
        rotationRules: rotationSnapshot,
        memos: memosSnapshot,
        completionHistory: completionHistorySnapshot,
        lastResetDate: lastReset,
        userSettings: userSettingsSnapshot,
        ankiSettings: prepared.settings,
        memoTags: memoTagsSnapshot,

      }
    },
    keyOmitted: Boolean(prepared.keyOmitted),
    keyOmitReason: prepared.omitReason || null
  }
}

/**
 * 导出全部数据为 .json 文件并触发浏览器下载；UI 提示。
 * 未设置加密口令 / 加密不可用时仍导出，仅省略 API Key，并以非阻断提示告知。
 */
export async function exportBackup() {
  try {
    const built = await buildExportPayload()
    if (!built.ok) {
      showToast(I18N.toast.backup.exportFailed)
      return
    }
    const payload = built.payload
    const now = new Date()
    const filename = `njw_backup_${formatTimestampForFilename(now)}_${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}.json`
    triggerDownload(filename, JSON.stringify(payload, null, 2))
    if (built.keyOmitted) {
      showToast(t(I18N.toast.anki.keyOmittedExport, { reason: keyOmitReasonText(built.keyOmitReason) }))
    } else {
      const workflows = getWorkflows()
      const rotationRules = getRotationRules()
      const memos = getMemos()
      showToast(t(I18N.toast.backup.exportDone, { tasks: workflows.length, rules: rotationRules.length, notes: memos.length }))
    }
  } catch (e) {
    DBG('export:error', String(e?.stack || e))
    showToast(I18N.toast.backup.exportFailed)
  }
}

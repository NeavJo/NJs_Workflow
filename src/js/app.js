/**
 * NJsWorkflow · 启动入口（bootstrap）
 * -----------------------------------------------------------------------------
 * 职责：装载持久化状态 → 注入运行时依赖 → 渲染初始 UI → 绑定事件
 *      → 跨天校验 → 启动 Gist 自动同步 → 注册可见性 + Debug 钩子。
 *
 * 所有业务规则都已下沉到 src/js/{core,workflow,memo,settings,backup,config}，
 * 本文件只做"装配"，不写任何业务代码。
 */

import '../css/index.css'

import { showToast } from './ui.js'
import { DBG, registerDebugHook } from './core/debug.js'
import { hasGistCredentials, getGistSettings } from './core/settings-store.js'

import { loadRotationRules, getRotationRules, onRotationRulesChange } from './workflow/rotation-store.js'
import { loadWorkflows, getWorkflows } from './workflow/workflow-store.js'
import { loadCompleted } from './workflow/completion-store.js'
import {
  loadCompletionHistory,
  loadLastResetDate,
  checkDailyReset,
  getCompletionHistory
} from './workflow/history-store.js'
import { setMemoCountCheckDependencies } from './workflow/workflow-runtime.js'
import { renderDate, renderWorkflow } from './workflow/workflow-renderer.js'
import { bindWorkflowListEvents } from './workflow/workflow-events.js'

import {
  loadMemos,
  loadMemoTags,
  getMemos,
  getMemoTags,
  getSelectedMemoTag
} from './memo/memo-store.js'
import { parseMemoContentToMap } from './memo/memo-parser.js'
import { cleanExpiredMemos } from './memo/memo-retention.js'
import {
  renderMemos,
  renderTagSelector,
  renderMemoTagPickerTrigger,
  subscribeMemoChanges,
  subscribeMemoTagChanges
} from './memo/memo-renderer.js'
import { bindMemoEvents } from './memo/memo-events.js'

import { bindNavigationEvents, switchView } from './settings/navigation.js'
import {
  bindSettingsEvents,
  bindEditorEvents,
  bindTaskFormEvents,
  bindGlobalEscapeHandler,
  enterSettingsView
} from './settings/index.js'
import { bindGlobalModalEvents } from './settings/modal.js'

import { pullFromGist, renderGistSettingsInputs, scheduleAutoUpload } from './backup/gist-sync.js'
import './backup/events.js'
import { renderDailyResetStatus } from './backup/daily-reset.js'

/* ============================================================================
 * 1. 装载持久化状态
 *    注意：loadWorkflows() 必须在 loadCompleted() 之前，
 *    因为后者会用前者校验已勾选 ID 是否仍然有效。
 * ========================================================================= */
loadRotationRules()
loadWorkflows()
loadCompleted()
loadCompletionHistory()
loadLastResetDate()
loadMemos()
loadMemoTags()

/* ============================================================================
 * 2. 注入运行时依赖（生词本校验 → 自动打卡的回调）
 *    workflow-runtime.js 通过 setMemoCountCheckDependencies 解耦，
 *    让"校验通过后弹什么 toast"由 bootstrap 决定。
 * ========================================================================= */
setMemoCountCheckDependencies({
  getMemos,
  parseMemoContentToMap,
  onAfterComplete: ({ passed, wordCount, targetCount, displayCategory, remaining }) => {
    if (passed) {
      showToast(
        `校验成功！今日 ${displayCategory} 分类已记录 ${wordCount} 个生词，已为你完成打卡！`
      )
    } else {
      showToast(
        `检查未通过：今天 ${displayCategory} 分类下仅有 ${wordCount} 个生词（还需要 ${remaining} 个才达标哦）`
      )
    }
    renderWorkflow()
  }
})

/* ============================================================================
 * 3. 渲染初始 UI
 * ========================================================================= */
renderDate()
renderWorkflow()
renderTagSelector()
renderMemoTagPickerTrigger()
cleanExpiredMemos(getMemos())
renderMemos()

/* ============================================================================
 * 4. 绑定事件
 *    - backup/events.js 在 import 时已通过 registerBackupEvents(bindBackupEvents)
 *      把事件绑定函数挂到 settings/index.js 的备份区，所以 bindSettingsEvents()
 *      会自动把导出 / Gist / Drop Zone / 每日重置 等按钮一并绑定。
 *    - 设置页钩子由 settings/index.js 在模块加载时通过 registerViewHook('settings', enterSettingsView)
 *      注册；首次进入或重新进入设置页时会重置子页面 + 刷新动态内容。
 * ========================================================================= */
bindNavigationEvents()
bindWorkflowListEvents()
bindMemoEvents()
bindSettingsEvents()
bindEditorEvents()
bindTaskFormEvents()
bindGlobalEscapeHandler()
bindGlobalModalEvents()

subscribeMemoChanges()
subscribeMemoTagChanges()
onRotationRulesChange(() => {
  renderWorkflow()
})

// 进入首页，确保状态与视图一致（不强制重置设置子页）
enterSettingsView({ resetSubpage: false })
switchView('flow')

/* ============================================================================
 * 5. 启动时跨天检查
 *    若今天 > lastResetDate，会自动把昨日打卡归档并清空今日。
 *    必须先于"自动上传 Gist"，避免把刚刚清空的状态写回云端。
 * ========================================================================= */
checkDailyReset({ reason: 'init' })

/* ============================================================================
 * 6. 启动时自动拉取 Gist（凭证有效时）
 *    - silent 模式屏蔽中间提示；成功静默，仅在失败时弹通知提醒
 * ========================================================================= */
async function autoPullOnStartup() {
  if (!hasGistCredentials()) return
  const settings = getGistSettings()
  DBG('init:auto-pull', { gistId: settings.gistId })
  const res = await pullFromGist({ silent: true })
  if (!res.ok && res.notify) {
    showToast(`启动同步失败：${res.notify}`)
  } else if (!res.ok && res.reason && res.reason !== 'user-cancel') {
    showToast(`启动同步失败：${res.reason}`)
  }
  renderGistSettingsInputs()
  renderDailyResetStatus()
}
autoPullOnStartup()

/* ============================================================================
 * 7. 切回前台时再次校验
 *    visibilitychange 比 setInterval 更省电。
 * ========================================================================= */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  DBG('event:visibilitychange', 'visible')
  checkDailyReset({ reason: 'visibility' })
})

/* ============================================================================
 * 8. Debug 探针：浏览器控制台执行 `window.debugNJ()` 即可拿到内存快照。
 * ========================================================================= */
registerDebugHook(() => ({
  workflows: getWorkflows(),
  rotationRules: getRotationRules(),
  memos: getMemos(),
  memoTags: getMemoTags(),
  selectedTag: getSelectedMemoTag(),
  history: getCompletionHistory()
}))

DBG('init:ready', {
  workflowsCount: getWorkflows().length,
  rotationRulesCount: getRotationRules().length,
  memosLength: getMemos().length,
  memoTagsCount: getMemoTags().length,
  selectedTag: getSelectedMemoTag(),
  historyDays: Object.keys(getCompletionHistory()).length
})

document.body.classList.remove('app-loading')

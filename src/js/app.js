/**
 * NJsWorkflow · 启动入口（bootstrap）
 * -----------------------------------------------------------------------------
 * 职责：装载持久化状态 → 注入运行时依赖 → 渲染初始 UI → 绑定事件
 *      → 跨天校验 → 启动 Gist 自动同步 → 注册可见性 + Debug 钩子。
 *
 * 所有业务规则都已下沉到 src/js/{core,workflow,memo,settings,backup,config}，
 * 本文件只做"装配"，不写任何业务代码。
 */

import { showToast } from './ui.js'
import { DBG, registerDebugHook } from './core/debug.js'
import { errorHandler, ErrorTypes, ErrorSeverity } from './core/error-handler.js'
import { hasGistCredentials, getGistSettings } from './core/settings-store.js'
import { I18N, t, applyI18nToDom } from './locales.js'

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
import { renderWorkflow } from './workflow/workflow-renderer.js'
import { bindWorkflowListEvents } from './workflow/workflow-events.js'
import { MonthlyView } from './workflow/monthly-view.js'

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

import { bindNavigationEvents, switchView, registerViewHook } from './settings/navigation.js'
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

import {
  loadAnkiSettings,
  getAnkiSettings,
  hasAnkiCredentials,
  renderAnkiSettingsInputs,
  bindAnkiSettingsEvents,
  bindAnkiProcessorEvents
} from './anki/index.js'
import {
  unlockFromRemembered,
  isPassphraseUnlocked,
  hasRememberedPassphrase
} from './anki/anki-passphrase.js'

/* ============================================================================
 * 1. 装载持久化状态
 *    注意：loadWorkflows() 必须在 loadCompleted() 之前，
 *    因为后者会用前者校验已勾选 ID 是否仍然有效。
 * ========================================================================= */
try {
  loadRotationRules()
  loadWorkflows()
  loadCompleted()
  loadCompletionHistory()
  loadLastResetDate()
  loadMemos()
  loadMemoTags()
  loadAnkiSettings()
  unlockFromRemembered()
  
  DBG('init:storage', 'All persistent state loaded successfully')
} catch (error) {
  errorHandler.handleError(error, {
    type: ErrorTypes.SYSTEM,
    severity: ErrorSeverity.CRITICAL,
    context: { stage: 'storage_loading' }
  })
}

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
        t(I18N.toast.workflow.checkSuccess, { category: displayCategory, count: wordCount })
      )
    } else {
      showToast(
        t(I18N.toast.workflow.checkFail, { category: displayCategory, count: wordCount, remaining })
      )
    }
    renderWorkflow()
  }
})

/* ============================================================================
 * 3. 渲染初始 UI
 *    先应用 locales.js 中的静态文案（data-i18n），再由各渲染器填充动态内容。
 * ========================================================================= */
try {
  applyI18nToDom()
  renderWorkflow()
  renderTagSelector()
  renderMemoTagPickerTrigger()
  cleanExpiredMemos(getMemos())
  renderMemos()
  renderAnkiSettingsInputs()

  const monthlyViewContainer = document.getElementById('monthly-view-container')
  if (monthlyViewContainer) {
    registerViewHook('monthly', ({ isFirstEntry }) => {
      if (!monthlyViewContainer.querySelector('.monthly-view')) {
        const monthlyView = new MonthlyView(monthlyViewContainer)
        monthlyView.render()
      }
    })
  }

  DBG('init:ui', 'Initial UI rendered successfully')
} catch (error) {
  errorHandler.handleError(error, {
    type: ErrorTypes.SYSTEM,
    severity: ErrorSeverity.HIGH,
    context: { stage: 'ui_rendering' }
  })
}

/* ============================================================================
 * 4. 绑定事件
 *    - backup/events.js 在 import 时已通过 registerBackupEvents(bindBackupEvents)
 *      把事件绑定函数挂到 settings/index.js 的备份区，所以 bindSettingsEvents()
 *      会自动把导出 / Gist / Drop Zone / 每日重置 等按钮一并绑定。
 *    - 设置页钩子由 settings/index.js 在模块加载时通过 registerViewHook('settings', enterSettingsView)
 *      注册；首次进入或重新进入设置页时会重置子页面 + 刷新动态内容。
 * ========================================================================= */
try {
  bindNavigationEvents()
  bindWorkflowListEvents()
  bindMemoEvents()
  bindSettingsEvents()
  bindEditorEvents()
  bindTaskFormEvents()
  bindGlobalEscapeHandler()
  bindGlobalModalEvents()
  bindAnkiSettingsEvents()
  bindAnkiProcessorEvents()

  subscribeMemoChanges()
  subscribeMemoTagChanges()
  onRotationRulesChange(() => {
    renderWorkflow()
  })
  
  DBG('init:events', 'All event listeners bound successfully')
} catch (error) {
  errorHandler.handleError(error, {
    type: ErrorTypes.SYSTEM,
    severity: ErrorSeverity.HIGH,
    context: { stage: 'event_binding' }
  })
}

// 进入首页，确保状态与视图一致（不强制重置设置子页）
enterSettingsView({ resetSubpage: false })
switchView('flow')

/* ============================================================================
 * 5. 启动时跨天检查
 *    若今天 > lastResetDate，会自动把昨日打卡归档并清空今日。
 *    必须先于"自动上传 Gist"，避免把刚刚清空的状态写回云端。
 * ========================================================================= */
try {
  checkDailyReset({ reason: 'init' })
  DBG('init:daily-reset', 'Daily reset check completed')
} catch (error) {
  errorHandler.handleError(error, {
    type: ErrorTypes.SYSTEM,
    severity: ErrorSeverity.MEDIUM,
    context: { stage: 'daily_reset' }
  })
}

/* ============================================================================
 * 6. 启动时自动拉取 Gist（凭证有效时）
 *    - silent 模式屏蔽中间提示；成功静默，仅在失败时弹通知提醒
 * ========================================================================= */
async function autoPullOnStartup() {
  try {
    if (!hasGistCredentials()) return
    
    const settings = getGistSettings()
    DBG('init:auto-pull', { gistId: settings.gistId })
    
    const res = await pullFromGist({ silent: true })
    if (!res.ok && res.notify) {
      showToast(t(I18N.toast.system.startupSyncFailed, { reason: res.notify }))
    } else if (!res.ok && res.reason && res.reason !== 'user-cancel') {
      showToast(t(I18N.toast.system.startupSyncFailed, { reason: res.reason }))
    }
    
    renderGistSettingsInputs()
    renderDailyResetStatus()
    renderAnkiSettingsInputs()
    
    DBG('init:auto-pull', 'Gist sync completed successfully')
  } catch (error) {
    errorHandler.handleError(error, {
      type: ErrorTypes.NETWORK,
      severity: ErrorSeverity.MEDIUM,
      context: { stage: 'gist_sync' }
    })
  }
}

autoPullOnStartup().catch(error => {
  errorHandler.handleError(error, {
    type: ErrorTypes.NETWORK,
    severity: ErrorSeverity.MEDIUM,
    context: { stage: 'gist_sync_fallback' }
  })
})

/* ============================================================================
 * 7. 切回前台时再次校验
 *    visibilitychange 比 setInterval 更省电。
 * ========================================================================= */
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  
  try {
    DBG('event:visibilitychange', 'visible')
    checkDailyReset({ reason: 'visibility' })
  } catch (error) {
    errorHandler.handleError(error, {
      type: ErrorTypes.SYSTEM,
      severity: ErrorSeverity.MEDIUM,
      context: { stage: 'visibility_check' }
    })
  }
})

/* ============================================================================
 * 8. Debug 探针：浏览器控制台执行 `window.debugNJ()` 即可拿到内存快照。
 * ========================================================================= */
try {
  registerDebugHook(() => {
    try {
      const anki = getAnkiSettings()
      return {
        workflows: getWorkflows(),
        rotationRules: getRotationRules(),
        memos: getMemos(),
        memoTags: getMemoTags(),
        selectedTag: getSelectedMemoTag(),
        history: getCompletionHistory(),
        anki: {
          hasKey: hasAnkiCredentials(),
          apiType: anki.apiType,
          baseUrl: anki.baseUrl,
          modelId: anki.modelId,
          hasCustomPrompt: Boolean(anki.prompt),
          passphraseState: isPassphraseUnlocked()
            ? 'unlocked'
            : hasRememberedPassphrase()
              ? 'remembered-locked'
              : 'none',
          hasEncryptedKey: Boolean(anki.apiKeyEncrypted)
        }
      }
    } catch (error) {
      errorHandler.handleError(error, {
        type: ErrorTypes.SYSTEM,
        severity: ErrorSeverity.LOW,
        context: { stage: 'debug_hook' }
      })
      return null
    }
  })

  DBG('init:ready', {
    workflowsCount: getWorkflows().length,
    rotationRulesCount: getRotationRules().length,
    memosLength: getMemos().length,
    memoTagsCount: getMemoTags().length,
    selectedTag: getSelectedMemoTag(),
    historyDays: Object.keys(getCompletionHistory()).length,
    ankiHasKey: hasAnkiCredentials(),
    ankiHasCustomPrompt: Boolean(getAnkiSettings().prompt),
    ankiPassphraseUnlocked: isPassphraseUnlocked(),
    cryptoAvailable: Boolean(typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.importKey === 'function'),
    isSecureContext: typeof isSecureContext === 'boolean' ? isSecureContext : null
  })
} catch (error) {
  errorHandler.handleError(error, {
    type: ErrorTypes.SYSTEM,
    severity: ErrorSeverity.LOW,
    context: { stage: 'debug_registration' }
  })
}

document.body.classList.remove('app-loading')

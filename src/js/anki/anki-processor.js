import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N } from '../locales.js'
import { hasAnkiCredentials, getActiveProfile } from './anki-store.js'
import { loadAnkiPrompt } from './anki-prompt.js'
import { requestGemini, requestOpenAI } from './anki-api.js'
import { renderAnkiCards, bindAnkiOutputEvents } from './anki-output.js'
import { initAnkiProfileSelect } from './anki-profile-select.js'
import { $ } from '../utils/dom-utils.js'
import { createGuard } from '../utils/guard.js'

/**
 * Anki 处理机业务编排：
 *  - runAnkiProcessing：校验配置 → 加载 Prompt → 按apiType 调用 LLM → 按分类渲染输出卡片。
 *  - setProcessing：统一管理 Loading 态与按钮禁用（含动态卡片按钮），防止重复提交。
 */

// JS 级重入锁：与按钮 disabled 的 UI 防护形成双保险，防止程序化/竞态触发并发重复请求。
let isProcessing = false

// 幂等守卫：确保 bindAnkiProcessorEvents 可被重复调用而不重复绑定监听（D1）。
const guardProcessor = createGuard('ankiProcessorEventsBound')

function setProcessing(processing) {
  const runBtn = $('anki-run')
  const copyBtn = $('anki-copy')
  const dlBtn = $('anki-download')
  const profileSelect = $('anki-profile-select')
  const loadingEl = $('anki-loading')
  const buttons = [runBtn, copyBtn, dlBtn].filter(Boolean)
  document.querySelectorAll('#anki-output-cards button').forEach((btn) => buttons.push(btn))
  for (const btn of buttons) {
    btn.disabled = processing
    btn.classList.toggle('is-busy', processing)
  }
  if (profileSelect) profileSelect.disabled = processing
  if (runBtn) {
    const label = runBtn.querySelector('.anki-run-label')
    if (label) label.textContent = processing ? I18N.anki.processing : I18N.anki.startProcess
  }
  if (loadingEl) loadingEl.hidden = !processing
}

export async function runAnkiProcessing() {
  if (isProcessing) return
  const inputEl = $('anki-input')
  const cardsEl = $('anki-output-cards')
  if (!inputEl || !cardsEl) return
  const words = inputEl.value.trim()
  if (!words) {
    showToast(I18N.toast.anki.noWordsInput)
    return
  }
  if (!hasAnkiCredentials()) {
    showToast(I18N.toast.anki.noApiConfig)
    return
  }
  const activeProfile = getActiveProfile() || {}
  isProcessing = true
  setProcessing(true)
  try {
    const systemPrompt = await loadAnkiPrompt()
    if (!systemPrompt) {
      showToast(I18N.toast.anki.promptLoadFailed)
      return
    }
    DBG('anki:run:start', { apiType: activeProfile.apiType, modelId: activeProfile.modelId, wordsLen: words.length })
    const result = activeProfile.apiType === 'openai'
      ? await requestOpenAI({
          baseUrl: activeProfile.baseUrl,
          modelId: activeProfile.modelId,
          apiKey: activeProfile.apiKey,
          systemPrompt,
          userMessage: words
        })
      : await requestGemini({
          baseUrl: activeProfile.baseUrl,
          modelId: activeProfile.modelId,
          apiKey: activeProfile.apiKey,
          systemPrompt,
          userMessage: words
        })
    if (!result.ok) {
      DBG('anki:run:error', { status: result.status, error: result.error })
      showToast(result.error || I18N.toast.anki.aiFailed)
      return
    }
    const cardCount = renderAnkiCards(result.text)
    DBG('anki:run:done', { outputLen: result.text.length, categories: cardCount })
    showToast(I18N.toast.anki.aiDone)
  } catch (err) {
    DBG('anki:run:exception', String(err && err.stack || err))
    showToast(I18N.toast.anki.aiError)
  } finally {
    setProcessing(false)
    isProcessing = false
  }
}

export function bindAnkiProcessorEvents() {
  // 幂等守卫：可重复调用，杜绝重复监听（D1）
  if (guardProcessor.is()) return
  guardProcessor.set()
  const runBtn = $('anki-run')
  runBtn?.addEventListener('click', runAnkiProcessing)
  bindAnkiOutputEvents()
  // 主处理页档案选择器：渲染 + 幂等绑定 + 变更订阅
  initAnkiProfileSelect()
}

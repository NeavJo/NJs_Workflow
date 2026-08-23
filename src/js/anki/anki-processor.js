import { DBG } from '../core/debug.js'
import { getMemos } from '../memo/memo-store.js'
import { parseMemoContentToMap } from '../memo/memo-parser.js'
import { getTodayDateString } from '../core/date.js'
import { showToast } from '../ui.js'
import { I18N, t } from '../locales.js'
import { getAnkiSettings, hasAnkiCredentials } from './anki-store.js'
import { loadAnkiPrompt } from './anki-prompt.js'
import { requestGemini, requestOpenAI } from './anki-api.js'
import { renderAnkiCards, bindAnkiOutputEvents } from './anki-output.js'
import { $ } from '../utils/dom-utils.js'

/**
 * Anki 处理机业务编排：
 *  - readTodayWords：从今日笔记（Anki 相关标签）抽取去重生词填入输入框。
 *  - runAnkiProcessing：校验配置 → 加载 Prompt → 按apiType 调用 LLM → 按分类渲染输出卡片。
 *  - setProcessing：统一管理 Loading 态与按钮禁用（含动态卡片按钮），防止重复提交。
 */



export function readTodayWords() {
  const inputEl = $('anki-input')
  if (!inputEl) return
  const todayStr = getTodayDateString()
  const memos = getMemos()
  let fullText = ''
  for (const memo of memos) {
    const ts = String(memo.timestamp || '')
    if (!ts.startsWith(todayStr)) continue
    const tag = String(memo.tag || '')
    if (!/anki/i.test(tag)) continue
    fullText += (memo.content || '').trim() + '\n'
  }
  if (!fullText.trim()) {
    showToast(I18N.toast.anki.noWordsToday)
    return
  }
  inputEl.value = fullText.trim()
  DBG('anki:readToday', { length: fullText.length })
  showToast(t(I18N.toast.anki.wordsLoaded, { length: fullText.length }))
}

function setProcessing(processing) {
  const runBtn = $('anki-run')
  const readBtn = $('anki-read-today')
  const copyBtn = $('anki-copy')
  const dlBtn = $('anki-download')
  const loadingEl = $('anki-loading')
  const buttons = [runBtn, readBtn, copyBtn, dlBtn].filter(Boolean)
  document.querySelectorAll('#anki-output-cards button').forEach((btn) => buttons.push(btn))
  for (const btn of buttons) {
    btn.disabled = processing
    btn.classList.toggle('is-busy', processing)
  }
  if (runBtn) {
    const label = runBtn.querySelector('.anki-run-label')
    if (label) label.textContent = processing ? I18N.anki.processing : I18N.anki.startProcess
  }
  if (loadingEl) loadingEl.hidden = !processing
}

export async function runAnkiProcessing() {
  const inputEl = $('anki-input')
  const cardsEl = $('anki-output-cards')
  if (!inputEl || !cardsEl) return
  const words = inputEl.value.trim()
  if (!words) {
    showToast('请先输入或读取需要处理的单词。')
    return
  }
  if (!hasAnkiCredentials()) {
    showToast('请先在设置中配置 API Key 与模型。')
    return
  }
  const settings = getAnkiSettings()
  setProcessing(true)
  try {
    const systemPrompt = await loadAnkiPrompt()
    if (!systemPrompt) {
      showToast(I18N.toast.anki.promptLoadFailed)
      return
    }
    DBG('anki:run:start', { apiType: settings.apiType, wordsLen: words.length })
    const result = settings.apiType === 'openai'
      ? await requestOpenAI({
          baseUrl: settings.baseUrl,
          modelId: settings.modelId,
          apiKey: settings.apiKey,
          systemPrompt,
          userMessage: words
        })
      : await requestGemini({
          baseUrl: settings.baseUrl,
          modelId: settings.modelId,
          apiKey: settings.apiKey,
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
  }
}

export function bindAnkiProcessorEvents() {
  const readBtn = $('anki-read-today')
  const runBtn = $('anki-run')
  readBtn?.addEventListener('click', readTodayWords)
  runBtn?.addEventListener('click', runAnkiProcessing)
  bindAnkiOutputEvents()
}

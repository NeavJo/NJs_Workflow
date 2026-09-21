/**
 * german-events.js — 事件层：防抖联想 / 候选点击 / LLM 查询 / 发音 / 加词
 * -----------------------------------------------------------------------------
 * 架构：
 *   输入 → 防抖 → 本地模糊匹配(0ms) → 候选下拉
 *   候选点击/Enter → 查缓存 → 命中则渲染 / 未命中则调 LLM → 骨架屏 → 渲染 → 缓存
 *
 * 约束：
 *   - createGuard 幂等绑定
 *   - DOM 不存在安全返回
 *   - 事件委托绑定在静态容器上（候选列表、详情区）
 *   - 每个绑定独立，互不影响
 */

import { createGuard } from '../utils/guard.js'
import { DBG } from '../core/debug.js'
import { I18N, t } from '../locales.js'
import { showToast } from '../ui.js'
import {
  searchLocalDictionary,
  loadGermanDictionary,
  onDictionaryLoaded,
  setPendingQuery
} from './german-dictionary.js'
import { lookupWordViaLLM, removeCachedDetail } from './german-llm.js'
import { getGermanTtsApiKey } from './german-font-size.js'
import {
  setSuggestions,
  resetInput,
  startLookup,
  resolveLookup,
  failLookup,
  getGermanState
} from './german-store.js'
import { appendOrDailyMemo, getSelectedMemoTag } from '../memo/memo-store.js'

const guard = createGuard('germanEventsBound')
const SUGGEST_DEBOUNCE_MS = 200
let suggestTimer = null

// ── DOM 获取 ──
function getInput() { return document.getElementById('german-search-input') }
function getClearBtn() { return document.getElementById('german-clear-input') }
function getSuggestionsEl() { return document.getElementById('german-suggestions') }
function getRetryBtn() { return document.getElementById('german-retry') }
function getDetailRoot() { return document.getElementById('german-detail') }

/** 获取当前详情卡显示的单词（用于发音和加词本）。 */
function getDetailWord() {
  const wordEl = getDetailRoot()?.querySelector('.german-detail-card__word')
  return wordEl?.textContent?.trim() || getInput()?.value?.trim() || ''
}

// ── 本地联想（0 延迟） ──
function runSuggest(query) {
  const q = (query || '').trim()
  if (!q) {
    resetInput()
    return
  }
  // 记录当前查询值，完整索引加载完成后会用它重新搜索并更新候选
  setPendingQuery(q)
  const list = searchLocalDictionary(q, 8)
  setSuggestions(list)
}

// ── LLM 详情查询 ──
async function runLookup(word, options) {
  const w = (word || '').trim()
  if (!w) {
    showToast(t(I18N.german.toasts.searchEmpty))
    return
  }

  const seq = startLookup(w)

  const result = await lookupWordViaLLM(w, options)
  if (!result.ok) {
    failLookup(result.message || I18N.german.toasts.searchFailed, seq)
    return
  }

  // 缓存命中提示
  if (result.cached) {
    showToast('缓存命中', { status: 'info' })
  } else if (options && options.refetch) {
    // 重新获取成功（走了 LLM 刷新缓存）
    showToast(t(I18N.german.toasts.refetchDone, { word: w }), { status: 'success' })
  }

  resolveLookup(result.detail, seq)
}

/** 重新获取按钮：清除本地缓存并强制重新蒸馏。 */
function runRefetch() {
  const w = getDetailWord()
  if (!w) return
  removeCachedDetail(w)
  runLookup(w, { refetch: true })
}

// ── 发音 ──
// 单一网络音频源（无 Worker / 无后端 / 无浏览器 Web Speech）：
//   TTS.ai 神经网络 TTS。API Key 从设置页读取（存本地 localStorage），绝不硬编码进代码。
//   - 用户在设置页填写了 Key：优先用 Kokoro 高音质模型（带 Key）；
//   - 未填写 Key 或 Kokoro 请求失败（401/403/超时等）：自动回退匿名 Piper 免费引擎兜底。
// 全部失败时静默捕获并弹一次轻量 Toast，绝不回退到浏览器默认语音。
/** 单源请求超时阈值（毫秒） */
const TTS_TIMEOUT_MS = 8000

/** TTS.ai 最大轮询次数。 */
const TTAI_POLL_MAX = 7

/**
 * 轮询指数退避基数（毫秒）。
 * 第 i 次（从 1 开始）未命中时的等待 = min(base * 2^(i-1), 上限)。
 * 总耗时仍受 TTS_TIMEOUT_MS 约束（for 循环每次开头都检查 deadline），
 * 故最坏轮询次数不超过 TTAI_POLL_MAX，行为上界不变，只是把请求摊得更稀。
 */
const TTAI_POLL_BACKOFF_BASE_MS = 600
const TTAI_POLL_BACKOFF_MAX_MS = 3000

/** 当前正在播放的 Audio，避免多源叠加。 */
let activeAudio = null

/** TTS 重入守卫：同一时刻只允许一个 speakViaTtsAi 在跑。 */
let ttsInFlight = false

/**
 * TTS.ai 神经网络源：POST /v1/tts/ → 轮询结果 → 下载 MP3。
 * 模型选择策略（每次点击发音时实时读取设置页的 Key）：
 *   - 有 Key：优先 Kokoro（高音质，带 x-api-key）；提交失败则回退匿名 Piper。
 *   - 无 Key：直接匿名 Piper（免 Key 免费层），保证离线/未配置也能发音。
 * 流程为异步队列制：
 *   1) POST /v1/tts/ 提交任务（可能带 Key）→ 返回 uuid
 *   2) 轮询 GET /v1/speech/results/?uuid= 直至 status=completed（指数退避）→ 返回 result_url
 *   3) 下载 result_url 音频 Blob 并播放
 * 整体受 TTS_TIMEOUT_MS 约束，超时或任一环节失败抛错（由上层 Toast 处理，不回退浏览器语音）。
 */
function speakViaTtsAi(word) {
  const deadline = Date.now() + TTS_TIMEOUT_MS
  const abort = new AbortController()
  const signal = abort.signal

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  /**
   * 提交一次任务。
   * @param {string} model 合成模型（kokoro 高音质 / piper 匿名免费层）
   * @param {string|null} apiKey 携带的 API Key；null 表示匿名请求
   */
  async function submitTask(model, apiKey) {
    const headers = { 'Content-Type': 'application/json' }
    if (apiKey) headers['x-api-key'] = apiKey
    const submitRes = await fetch('https://api.tts.ai/v1/tts/', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, text: word, language: 'de', format: 'mp3' }),
      signal
    })
    if (!submitRes.ok) throw new Error('submit HTTP ' + submitRes.status)
    const submitData = await submitRes.json()
    return submitData.uuid
  }

  return (async () => {
    // 1) 读取设置页的 Key，决定走 Kokoro（带 Key）还是匿名 Piper
    const apiKey = getGermanTtsApiKey()
    let uuid
    if (apiKey) {
      // 有高音质 Key：优先 Kokoro，失败（Key 失效/网络/超时）才回退匿名 Piper
      try {
        uuid = await submitTask('kokoro', apiKey)
      } catch (err) {
        if (Date.now() >= deadline) throw new Error('submit timeout')
        DBG('german:speak:kokoro-failed', { err: String(err), word })
        uuid = await submitTask('piper', null)
      }
    } else {
      // 未配置 Key：直接匿名 Piper，保证无 Key 也能发音
      uuid = await submitTask('piper', null)
    }
    if (!uuid) throw new Error('no uuid')

    // 2) 轮询结果直至 completed（受 deadline 约束）
    // 指数退避：第 i 次未命中等待 base * 2^(i-1)，封顶 TTAI_POLL_BACKOFF_MAX_MS。
    // 相比固定 1200ms，退避把高频无效轮询摊薄，同时 deadline 兜底保证总时长不变上界。
    let resultUrl = ''
    for (let i = 0; i < TTAI_POLL_MAX; i++) {
      if (Date.now() >= deadline) throw new Error('poll timeout')
      const pollRes = await fetch(
        'https://api.tts.ai/v1/speech/results/?uuid=' + encodeURIComponent(uuid),
        { signal }
      )
      if (!pollRes.ok) throw new Error('poll HTTP ' + pollRes.status)
      const pollData = await pollRes.json()
      if (pollData.status === 'completed') {
        resultUrl = pollData.result_url
        break
      }
      if (pollData.status === 'failed') throw new Error('ttsai job failed')
      // 最后一次轮询无需再等待（循环即将结束且会由 deadline / !resultUrl 判定超时）
      if (i < TTAI_POLL_MAX - 1) {
        const waitMs = Math.min(
          TTAI_POLL_BACKOFF_BASE_MS * Math.pow(2, i),
          TTAI_POLL_BACKOFF_MAX_MS
        )
        await sleep(waitMs)
        // 等待后再次检查 deadline：退避时间可能已耗尽总预算，避免空耗
        if (Date.now() >= deadline) throw new Error('poll timeout')
      }
    }
    if (!resultUrl) throw new Error('poll timeout')

    // 3) 下载音频并播放
    const audioRes = await fetch(resultUrl, { signal })
    if (!audioRes.ok) throw new Error('download HTTP ' + audioRes.status)
    const blob = await audioRes.blob()
    return playAudioBlob(blob)
  })().catch((err) => {
    abort.abort()
    throw err
  })
}

/** 播放音频 Blob，自动清理旧 Audio；返回 Promise 供调用方判断是否成功。 */
function playAudioBlob(blob) {
  if (activeAudio) {
    try { activeAudio.pause() } catch { /* noop */ }
    activeAudio = null
  }
  const url = URL.createObjectURL(blob)
  activeAudio = new Audio(url)
  activeAudio.addEventListener('ended', () => {
    URL.revokeObjectURL(url)
    activeAudio = null
  })
  return activeAudio.play().catch((err) => {
    URL.revokeObjectURL(url)
    activeAudio = null
    throw err
  })
}

/**
 * 发音入口：仅使用 TTS.ai 网络音频源（kokoro → 匿名 piper 回退）。
 * 失败（网络/超时/HTTP/autoplay 拦截）时静默捕获并弹一次 Toast，
 * 绝不回退到浏览器默认语音。
 *
 * 重入守卫：同一时刻只允许一个发音任务在跑；
 * 若前一个仍在飞行中，本次直接忽略（避免多任务并发抢 activeAudio、
 * 多次弹窗、轮询风暴）。用户需等上一次完成后再点。
 */
function speakWord(word) {
  const w = (word || '').trim()
  if (!w) return
  if (ttsInFlight) {
    DBG('german:speak:skip-reentrant', { word: w })
    return
  }
  ttsInFlight = true
  DBG('german:speak', { word: w })

  speakViaTtsAi(w)
    .then(() => {
      DBG('german:speak:success', { word: w })
    })
    .catch((err) => {
      DBG('german:speak:source-failed', { word: w, err: String(err) })
      // 网络源失败：静默捕获，仅弹一次轻量提示，不播放任何语音
      showToast(I18N.german.toasts.speakNetworkFailed, { status: 'error' })
    })
    .finally(() => {
      ttsInFlight = false
    })
}

// ── 加入生词本 ──
// 标签和分类都继承生词本记事本页面当前的选择状态（memo-store 单例）：
// 用户先在生词本页面切换标签 / 填写分类，再回到德语助手点按钮，
// 单词就会落到对应标签下的对应分类块里；未操作过分类输入框则回退到"常规"。
function addCurrentToMemo() {
  const word = getDetailWord()
  if (!word) return
  const currentTag = getSelectedMemoTag()
  const result = appendOrDailyMemo(word, currentTag)
  if (result) {
    showToast(
      t(I18N.german.toasts.memoAdded, { word, tag: currentTag, category: result.category }),
      { status: 'success' }
    )
    DBG('german:memo:added', { word, mode: result.mode, tag: currentTag, category: result.category })
  } else {
    showToast(I18N.german.toasts.memoFailed, { status: 'error' })
    DBG('german:memo:failed', { word })
  }
}

// ── 事件绑定 ──

/** 搜索框：防抖联想 + 回车查询。 */
function bindGermanSearch() {
  const input = getInput()
  if (!input) return
  input.addEventListener('input', () => {
    const value = input.value.trim()
    const clearBtn = getClearBtn()
    if (clearBtn) clearBtn.hidden = value.length === 0
    if (suggestTimer) clearTimeout(suggestTimer)
    suggestTimer = setTimeout(() => {
      runSuggest(value)
    }, SUGGEST_DEBOUNCE_MS)
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (suggestTimer) { clearTimeout(suggestTimer); suggestTimer = null }
      // 关闭候选下拉
      const list = getSuggestionsEl()
      if (list) list.hidden = true
      runLookup(input.value)
    }
  })
}

/** 清空按钮。 */
function bindClearButton() {
  const btn = getClearBtn()
  if (!btn) return
  btn.addEventListener('click', () => {
    const input = getInput()
    if (input) { input.value = ''; input.focus() }
    if (suggestTimer) { clearTimeout(suggestTimer); suggestTimer = null }
    resetInput()
    btn.hidden = true
  })
}

/** 候选词点击：事件委托在 listbox 上。 */
function bindSuggestionSelect() {
  const list = getSuggestionsEl()
  if (!list) return
  list.addEventListener('click', (event) => {
    const item = event.target.closest('.german-suggestion')
    if (!item) return
    const word = item.dataset.word || ''
    const input = getInput()
    if (input) input.value = word
    const clearBtn = getClearBtn()
    if (clearBtn) clearBtn.hidden = !word
    // 选中即收起候选框：同步清空 store 的 suggestions，
    // 否则下一次 renderGermanAssistant 仍会把旧候选重新渲染出来。
    setSuggestions([])
    runLookup(word)
  })
}

/** 重试按钮。 */
function bindRetry() {
  const btn = getRetryBtn()
  if (!btn) return
  btn.addEventListener('click', () => {
    runLookup(getInput()?.value)
  })
}

/**
 * 点击搜索框与候选框以外的任意空白区域时，自动收起候选框。
 * 在 document 上监听 mousedown（先于 click，避免与点击候选项/输入框的冒泡冲突）。
 * 命中搜索卡（含输入框 + 候选下拉）内部时不收起，保持正常交互。
 */
function bindOutsideClick() {
  document.addEventListener('mousedown', (event) => {
    const list = getSuggestionsEl()
    if (!list || list.hidden) return
    const card = list.closest('.german-search-card')
    if (card && card.contains(event.target)) return
    // 命中外部空白：清空 store，候选下拉随之隐藏
    setSuggestions([])
  })
}

/** 详情区内动态按钮（发音 / 加词）：事件委托。 */
function bindDetailActions() {
  const rootEl = getDetailRoot()
  if (!rootEl) return
  rootEl.addEventListener('click', (event) => {
    if (event.target.closest('.german-speak')) {
      speakWord(getDetailWord())
      return
    }
    if (event.target.closest('.german-refetch')) {
      runRefetch()
      return
    }
    if (event.target.closest('.german-add-memo')) {
      addCurrentToMemo()
    }
  })
}

/**
 * 绑定德语助手全部事件（幂等，guard 保证只绑一次）。
 */
export function bindGermanAssistantEvents() {
  if (guard.is(document)) return
  guard.set(document)

  bindGermanSearch()
  bindClearButton()
  bindSuggestionSelect()
  bindOutsideClick()
  bindRetry()
  bindDetailActions()

  // 完整索引加载完成后，用当前查询值刷新候选，无需用户重新输入
  onDictionaryLoaded((query) => {
    const input = getInput()
    const current = input?.value || query
    if (current) runSuggest(current)
  })

  // 触发静态分层词库加载（首层 → 完整，均为幂等）
  try {
    loadGermanDictionary()
  } catch (error) {
    DBG('german:dict:load-trigger-failed', String(error))
  }

  DBG('german:events-bound')
}

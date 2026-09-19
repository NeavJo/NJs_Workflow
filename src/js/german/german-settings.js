/**
 * german-settings.js — 德语助手设置：字号档位滑块
 * -----------------------------------------------------------------------------
 * 职责：
 *   - 渲染设置页"德语助手设置"子页的字号滑块（读当前档位 → 回填滑块 + 档位标签）
 *   - 绑定滑块 input/change，调用 setGermanFontSizeLevel 完成"持久化 + 应用 + 发布"
 *   - 订阅 onGermanFontSizeChange，在已有结果页上即时重渲染（字号变化 → 实时联动）
 *
 * 模块边界：
 *   - 只操作德语字号相关的 DOM，不改其它模块状态
 *   - 持久化、缩放因子、PubSub 全在 german-font-size.js，本文件只做 UI 粘合
 *   - 幂等守卫统一走 guard.js，避免重复绑定
 */

import { createGuard } from '../utils/guard.js'
import { I18N, t } from '../locales.js'
import { DBG } from '../core/debug.js'
import { switchSettingsView } from '../settings/navigation.js'
import {
  getGermanFontSizeLevel,
  setGermanFontSizeLevel,
  onGermanFontSizeChange,
  applyGermanFontScaleToDOM,
  getGermanTtsApiKey,
  setGermanTtsApiKey
} from './german-font-size.js'
import { getGermanState } from './german-store.js'
import { renderGermanAssistant } from './german-renderer.js'
import { showToast } from '../ui.js'

/** 档位标签（与滑块 1~5 对应；取 locales.settings.germanFontLabels 按逗号拆分） */
function getFontLevelLabels() {
  const raw = I18N.settings?.germanFontLabels || '最小,较小,正常,较大,最大'
  return raw.split(',').map((s) => s.trim())
}

function getFontInput() {
  return document.getElementById('german-font-size-level')
}

function getFontOutput() {
  return document.getElementById('german-font-size-output')
}

/**
 * 把当前持久化档位回填到滑块 + 档位标签。
 * 进入子页时调用一次；滑块值不在此处改，避免与用户拖动冲突。
 */
export function renderGermanFontSizeSettings() {
  const input = getFontInput()
  if (!input) return
  const level = getGermanFontSizeLevel()
  input.value = String(level)

  const output = getFontOutput()
  const labels = getFontLevelLabels()
  const label = labels[level - 1] || ''
  if (output) {
    output.textContent = t(I18N.settings.germanFontSizeLevel, { level, label })
  }
  DBG('german-settings:render', { level })
}

/** 滑块输入时实时更新档位（含持久化 + 应用 + 发布；失败不前进）。 */
function handleFontSizeInput() {
  const input = getFontInput()
  if (!input) return
  const level = Number(input.value)
  if (!Number.isInteger(level)) return
  setGermanFontSizeLevel(level)
}

/** 绑定滑块事件；幂等，重复调用直接返回。 */
export function bindGermanSettingsEvents() {
  const input = getFontInput()
  if (!input) return
  const guard = createGuard('germanFontSizeBound')
  if (guard.is(input)) return
  guard.set(input)

  // 拖动过程中即时响应；松手不再重复持久化（input 已覆盖 change 语义）
  input.addEventListener('input', handleFontSizeInput)
  input.addEventListener('change', handleFontSizeInput)
  DBG('german-settings:bound')
}

/**
 * 订阅字号档位变化：把缩放变量重新应用到已渲染的德语视图，并重渲染结果页。
 * 返回取消订阅函数。在子页不可见时仅安全应用变量，不强制渲染。
 */
export function subscribeGermanFontSizeForReflow() {
  return onGermanFontSizeChange(() => {
    const applied = applyGermanFontScaleToDOM()
    if (applied) {
      renderGermanAssistant(getGermanState())
    }
  })
}

/* ====================================================================
 * TTS API Key（德语助手发音用，存本地 localStorage，不随 Gist 同步）
 * 设计约束：
 *   - 持久化、PubSub 全在 german-font-size.js，本文件只做 UI 粘合
 *   - 保存/清空走逐按钮幂等守卫，DOM 不存在安全返回
 *   - 保存成功才提示成功；持久化失败提示失败，不回退到浏览器语音
 * ==================================================================== */

function getTtsKeyInput() {
  return document.getElementById('german-tts-api-key')
}

/** 进入子页时回填已保存的 TTS API Key（空值显示空输入框）。 */
export function renderTtsKeyInput() {
  const input = getTtsKeyInput()
  if (!input) return
  input.value = getGermanTtsApiKey()
  DBG('german-tts-key:render', { hasKey: Boolean(input.value) })
}

/** 保存输入框的 TTS API Key（允许保存空值=清空），持久化成功后才提示成功。 */
export function saveTtsKeyFromInputs() {
  const input = getTtsKeyInput()
  if (!input) return
  const value = input.value.trim()
  const persisted = setGermanTtsApiKey(value)
  if (!persisted) {
    showToast(I18N.settings.ttsKeySaveFailed, { status: 'error' })
    DBG('german-tts-key:save-failed')
    return
  }
  // 持久化成功后再回填，避免失败时输入框被清空
  input.value = getGermanTtsApiKey()
  showToast(I18N.settings.ttsKeySaveSuccess, { status: 'success' })
  DBG('german-tts-key:save', { hasKey: Boolean(value) })
}

/** 清空已保存的 TTS API Key（持久化成功后才清空输入框并提示）。 */
export function clearTtsKeyFromInputs() {
  const input = getTtsKeyInput()
  const persisted = setGermanTtsApiKey('')
  if (!persisted) {
    showToast(I18N.settings.ttsKeySaveFailed, { status: 'error' })
    DBG('german-tts-key:clear-failed')
    return
  }
  if (input) input.value = ''
  showToast(I18N.settings.ttsKeyCleared, { status: 'success' })
  DBG('german-tts-key:clear')
}

/** 绑定保存/清空按钮；幂等，重复调用直接返回。 */
export function bindTtsKeyEvents() {
  const saveBtn = document.getElementById('btn-german-tts-key-save')
  const clearBtn = document.getElementById('btn-german-tts-key-clear')
  if (!saveBtn && !clearBtn) return
  const guard = createGuard('germanTtsKeyBound')
  if (guard.is(saveBtn || clearBtn)) return
  guard.set(saveBtn || clearBtn)

  if (saveBtn) saveBtn.addEventListener('click', saveTtsKeyFromInputs)
  if (clearBtn) clearBtn.addEventListener('click', clearTtsKeyFromInputs)
  DBG('german-tts-key:bound')
}

/* ====================================================================
 * Anki LLM 提醒卡片跳转按钮
 * ==================================================================== */

/** 绑定"去配置"按钮：跳转到 anki-api 子页。 */
export function bindAnkiJumpButton() {
  const jumpBtn = document.getElementById('btn-german-anki-jump')
  if (!jumpBtn) return
  const guard = createGuard('germanAnkiJumpBound')
  if (guard.is(jumpBtn)) return
  guard.set(jumpBtn)
  jumpBtn.addEventListener('click', () => switchSettingsView('anki-api'))
  DBG('german-anki-jump:bound')
}

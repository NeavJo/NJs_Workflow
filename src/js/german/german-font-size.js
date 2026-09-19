/**
 * german-font-size.js — 德语助手字号档位（5 级）
 * -----------------------------------------------------------------------------
 * 职责：
 *   - 维护 1~5 档字号档位（存 userSettings，随 Gist / 导入导出同步）
 *   - 将档位映射为缩放因子，应用到 .view--german 的 CSS 变量 --german-font-scale
 *   - 通过 PubSub 通知"已渲染"的德语助手结果页即时重渲染（无需刷新页面）
 *
 * 设计约束：
 *   - 档位只存 number（1~5），normalize 越界值；持久化失败保持旧档，不发假成功
 *   - 第 3 档（scale=1.0）为基准默认值；第 2 档（0.95）≈ 上线时页面初始字号
 *   - 缩放变量挂在 .view--german 根节点上，只影响德语助手页，不影响其它视图
 */

import { createPubSub } from '../utils/pubsub.js'
import { DBG } from '../core/debug.js'
import { getUserSettings, setUserSettings, persistUserSettings } from '../core/settings-store.js'

const pubsub = createPubSub()

// 1~5 档对应的缩放因子：第 2 档 ≈ 当前视觉，第 3 档为基准默认，第 5 档最大
export const GERMAN_FONT_SCALES = [0.85, 0.95, 1.0, 1.1, 1.2]
export const DEFAULT_GERMAN_FONT_SIZE = 3

const STORAGE_FIELD = 'germanFontSizeLevel'

/** 把任意值归一为合法档位（1~5），非法/越界落回默认第 3 档。 */
function normalizeLevel(value) {
  const n = Number(value)
  if (Number.isInteger(n) && n >= 1 && n <= 5) return n
  return DEFAULT_GERMAN_FONT_SIZE
}

/** 取当前持久化档位（缺省为默认第 3 档）。 */
export function getGermanFontSizeLevel() {
  const raw = getUserSettings()[STORAGE_FIELD]
  return raw === undefined ? DEFAULT_GERMAN_FONT_SIZE : normalizeLevel(raw)
}

/** 取当前档位对应的缩放因子。 */
export function getGermanFontScale(level) {
  const lvl = typeof level === 'number' ? normalizeLevel(level) : getGermanFontSizeLevel()
  return GERMAN_FONT_SCALES[lvl - 1]
}

/** 把缩放变量写到德语助手根节点；DOM 不存在时安全返回 false。 */
export function applyGermanFontScaleToDOM(level) {
  const view = document.querySelector('.view--german')
  if (!view) return false
  const scale = getGermanFontScale(level)
  view.style.setProperty('--german-font-scale', String(scale))
  return true
}

/**
 * 设置档位并持久化。
 * 持久化成功后发布 PubSub（已渲染的德语结果页将据此重渲染）；
 * 失败时不修改内存档位、不发布通知，保持旧档。
 * @returns {boolean} 是否成功持久化
 */
export function setGermanFontSizeLevel(level) {
  const next = normalizeLevel(level)
  const prevLevel = getGermanFontSizeLevel()
  const settings = { ...getUserSettings(), [STORAGE_FIELD]: next }
  setUserSettings(settings)
  const persisted = persistUserSettings()
  if (!persisted) {
    // 持久化失败：回滚内存为旧档，避免内存与磁盘不一致
    setUserSettings({ ...settings, [STORAGE_FIELD]: prevLevel })
    DBG('german-font-size:persist-failed', { next, prevLevel })
    return false
  }
  applyGermanFontScaleToDOM(next)
  pubsub.emit(getGermanFontSizeLevel())
  DBG('german-font-size:changed', { next, scale: getGermanFontScale(next) })
  return true
}

/** 订阅档位变化；返回取消订阅函数。用于已渲染的德语结果页即时联动。 */
export function onGermanFontSizeChange(fn) {
  return pubsub.on(fn)
}

/** 启动时初始化：把已保存档位应用到 DOM，确保刷新后字号仍然生效。 */
export function initGermanFontScale() {
  applyGermanFontScaleToDOM(getGermanFontSizeLevel())
}

/* ====================================================================
 * TTS API Key（德语助手发音用，仅存本地 localStorage，不随 Gist 同步）
 * 设计约束：
 *   - 复用 userSettings 持久化（njs-workflow-user-settings），与字号档位同一份存储
 *   - 持久化成功后才更新内存 + 发布 PubSub；失败保持旧值，避免内存/磁盘不一致
 *   - 空字符串视为"未配置"，发音时走匿名免费层
 * ==================================================================== */
const TTS_API_KEY_FIELD = 'germanTtsApiKey'

/** 专用 PubSub：仅在 TTS Key 变更时通知订阅方，与字号档位互不干扰。 */
const ttsKeyPubsub = createPubSub()

/** 取当前持久化的 TTS API Key（未配置返回空字符串，绝不回退默认值）。 */
export function getGermanTtsApiKey() {
  const raw = getUserSettings()[TTS_API_KEY_FIELD]
  return typeof raw === 'string' ? raw.trim() : ''
}

/**
 * 设置 TTS API Key 并持久化。
 * @param {string} key 完整 Key 字符串（允许空字符串表示清空）
 * @returns {boolean} 是否成功持久化
 */
export function setGermanTtsApiKey(key) {
  const next = typeof key === 'string' ? key.trim() : ''
  const prev = getUserSettings()[TTS_API_KEY_FIELD]
  const settings = { ...getUserSettings(), [TTS_API_KEY_FIELD]: next }
  setUserSettings(settings)
  const persisted = persistUserSettings()
  if (!persisted) {
    // 持久化失败：回滚内存为旧值，避免内存与磁盘不一致
    setUserSettings({ ...settings, [TTS_API_KEY_FIELD]: prev ?? '' })
    DBG('german-tts-key:persist-failed', { changed: prev !== next })
    return false
  }
  // 持久化成功后才发布：发音侧据此感知 Key 已生效，无需刷新页面
  ttsKeyPubsub.emit(next)
  DBG('german-tts-key:changed', { hasKey: Boolean(next), persisted })
  return true
}

/** 订阅 TTS API Key 变化（值为新的 Key 字符串）；返回取消订阅函数。 */
export function onGermanTtsApiKeyChange(fn) {
  return ttsKeyPubsub.on(fn)
}

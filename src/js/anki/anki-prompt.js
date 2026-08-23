import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N } from '../locales.js'
import { getAnkiSettings } from './anki-store.js'

/**
 * Anki Prompt 模板加载器：
 *  - 默认提示词：从 ./docs/anki_prompt.txt 读取（dev/build 通用，依赖 Vite base），首次加载后缓存。
 *  - 自定义提示词：保存在 ankiSettings.prompt（随 Gist 一并同步），非空时优先使用。
 *  - loadAnkiPrompt() 返回当前生效的 System Prompt；读取失败时弹 Toast，返回空字符串，调用方据此中止处理。
 */

let cachedDefaultPrompt = null
let loadingPromise = null

function resolvePromptUrl() {
  const base = import.meta.env.BASE_URL || './'
  const tail = base.endsWith('/') ? base : `${base}/`
  return `${tail}docs/anki_prompt.txt`
}

function loadDefaultPrompt() {
  if (cachedDefaultPrompt) return Promise.resolve(cachedDefaultPrompt)
  if (loadingPromise) return loadingPromise
  const url = resolvePromptUrl()
  loadingPromise = fetch(url, { cache: 'no-cache' })
    .then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res.text()
    })
    .then((text) => {
      cachedDefaultPrompt = (text || '').trim()
      DBG('anki:prompt:default:loaded', { length: cachedDefaultPrompt.length })
      if (!cachedDefaultPrompt) {
        showToast('默认提示词为空，请检查 docs/anki_prompt.txt。')
      }
      return cachedDefaultPrompt
    })
    .catch((err) => {
      DBG('anki:prompt:default:error', { url, err: String(err) })
      showToast(I18N.toast.anki.defaultPromptLoadFailed)
      cachedDefaultPrompt = null
      loadingPromise = null
      return ''
    })
  return loadingPromise
}

export function getCachedAnkiPrompt() {
  const custom = getAnkiSettings().prompt
  if (custom) return custom
  return cachedDefaultPrompt
}

export function loadAnkiPrompt() {
  const custom = getAnkiSettings().prompt
  if (custom) {
    DBG('anki:prompt:effective', { source: 'custom', length: custom.length })
    return Promise.resolve(custom)
  }
  return loadDefaultPrompt()
}

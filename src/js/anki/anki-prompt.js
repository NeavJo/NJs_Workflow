import { DBG } from '../core/debug.js'
import { getAnkiSettings } from './anki-store.js'
import defaultPromptText from '../../../docs/anki_prompt.txt?raw'

/**
 * Anki Prompt 模板加载器：
 *  - 默认提示词：构建时通过 Vite ?raw 内联进 bundle，零网络请求，GitHub Pages 稳定可用。
 *  - 自定义提示词：保存在 ankiSettings.prompt（随 Gist 一并同步），非空时优先使用。
 *  - loadAnkiPrompt() 返回当前生效的 System Prompt；为空时弹 Toast，返回空字符串，调用方据此中止处理。
 */

const DEFAULT_PROMPT = (defaultPromptText || '').trim()

if (!DEFAULT_PROMPT) {
  console.warn('[anki-prompt] 默认提示词为空，请检查 docs/anki_prompt.txt')
}

export function getCachedAnkiPrompt() {
  const custom = getAnkiSettings().prompt
  if (custom) return custom
  return DEFAULT_PROMPT
}

export function loadAnkiPrompt() {
  const custom = getAnkiSettings().prompt
  if (custom) {
    DBG('anki:prompt:effective', { source: 'custom', length: custom.length })
    return Promise.resolve(custom)
  }
  DBG('anki:prompt:effective', { source: 'builtin', length: DEFAULT_PROMPT.length })
  if (!DEFAULT_PROMPT) {
    return Promise.resolve('')
  }
  return Promise.resolve(DEFAULT_PROMPT)
}

import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N } from '../locales.js'
import { ANKI_API_TYPES } from '../config/storage-config.js'
import { getAnkiSettings, setAnkiSettings, persistAnkiSettings } from './anki-store.js'
import {
  setPassphrase,
  clearPassphrase,
  isPassphraseUnlocked,
  hasRememberedPassphrase,
  getEffectivePassphrase
} from './anki-passphrase.js'
import { $ } from '../utils/dom-utils.js'

/**
 * Anki API 配置表单的双向绑定：
 *  - renderAnkiSettingsInputs：把 store 写回输入框 + 提示词状态
 *  - saveAnkiSettingsFromInputs：读取输入框 → 合并 → 持久化 → 回写
 *  - saveAnkiPromptFromInputs / resetAnkiPrompt：提示词保存与恢复默认
 *  - bindAnkiSettingsEvents：保存按钮 + apiType 联动默认 baseUrl + 提示词按钮
 *
 * 配置随系统全局数据保存并通过 requestAutoUpload() 同步至 Gist。
 */



const DEFAULT_BASE_URL_FOR_TYPE = {
  gemini: 'https://generativelanguage.googleapis.com',
  openai: 'https://api.openai.com/v1'
}

export function renderAnkiSettingsInputs() {
  const typeEl = $('anki-api-type')
  const urlEl = $('anki-base-url')
  const modelEl = $('anki-model-id')
  const keyEl = $('anki-api-key')
  const promptEl = $('anki-prompt-input')
  const promptStatusEl = $('anki-prompt-status')
  const settings = getAnkiSettings()
  if (typeEl) {
    if (!typeEl.options.length) {
      for (const t of ANKI_API_TYPES) {
        const opt = document.createElement('option')
        opt.value = t
        opt.textContent = t === 'gemini' ? I18N.anki.geminiLabel : I18N.anki.openaiLabel
        typeEl.appendChild(opt)
      }
    }
    typeEl.value = settings.apiType
  }
  if (urlEl) {
    if (settings.apiType === 'gemini') {
      urlEl.value = DEFAULT_BASE_URL_FOR_TYPE.gemini
    } else {
      urlEl.value = settings.baseUrl || ''
    }
    urlEl.disabled = settings.apiType === 'gemini'
  }
  if (modelEl) modelEl.value = settings.modelId || ''
  if (keyEl) keyEl.value = settings.apiKey || ''
  if (promptEl) promptEl.value = settings.prompt || ''
  if (promptStatusEl) {
    promptStatusEl.textContent = settings.prompt
      ? I18N.settings.promptStatusCustom
      : I18N.settings.promptStatusDefault
  }
  renderAnkiPassphraseStatus()
}

export function renderAnkiPassphraseStatus() {
  const statusEl = $('anki-passphrase-status')
  const passphraseEl = $('anki-passphrase-input')
  if (passphraseEl) passphraseEl.value = ''
  if (!statusEl) return
  const unlocked = isPassphraseUnlocked()
  const remembered = hasRememberedPassphrase()
  if (unlocked && remembered) {
    statusEl.textContent = I18N.settings.passphraseStatusRemembered
  } else if (unlocked) {
    statusEl.textContent = I18N.settings.passphraseStatusSession
  } else if (remembered) {
    statusEl.textContent = I18N.settings.passphraseStatusLockedRemembered
  } else {
    statusEl.textContent = I18N.settings.passphraseStatusNone
  }
  const hintEl = $('anki-passphrase-sync-hint-line')
  if (hintEl) {
    const hasApiKey = Boolean(getAnkiSettings().apiKey)
    const noPassphrase = !getEffectivePassphrase()
    hintEl.hidden = !(hasApiKey && noPassphrase)
  }
}

export function saveAnkiPassphraseFromInputs() {
  const passphraseEl = $('anki-passphrase-input')
  const rememberEl = $('anki-passphrase-remember')
  const passphrase = passphraseEl?.value || ''
  if (!passphrase) {
    showToast(I18N.toast.anki.passphraseEmpty)
    return
  }
  const remember = Boolean(rememberEl?.checked)
  const ok = setPassphrase(passphrase, { remember })
  if (passphraseEl) passphraseEl.value = ''
  renderAnkiPassphraseStatus()
  if (!ok) {
    showToast(I18N.toast.anki.passphraseSaveFailed)
  } else {
    showToast(remember ? I18N.toast.anki.passphraseSavedRemembered : I18N.toast.anki.passphraseSaved)
  }
  DBG('anki:passphrase:save', { remember, ok })
}

export function clearAnkiPassphrase() {
  if (!window.confirm(I18N.toast.anki.passphraseClearConfirm)) return
  clearPassphrase()
  renderAnkiPassphraseStatus()
  showToast(I18N.toast.anki.passphraseCleared)
  DBG('anki:passphrase:clear:ui')
}

export function saveAnkiPromptFromInputs() {
  const promptEl = $('anki-prompt-input')
  const prev = getAnkiSettings()
  const next = { ...prev, prompt: (promptEl?.value || '').trim() }
  const changed = prev.prompt !== next.prompt
  setAnkiSettings(next)
  const persisted = persistAnkiSettings()
  renderAnkiSettingsInputs()
  if (!persisted) {
    showToast(I18N.toast.anki.promptSaveFailed)
  } else if (changed) {
    showToast(next.prompt ? I18N.toast.anki.promptSaved : I18N.toast.anki.promptRestored)
  }
  DBG('anki:prompt:save', { changed, hasCustomPrompt: Boolean(next.prompt), persisted })
}

export function resetAnkiPrompt() {
  const promptEl = $('anki-prompt-input')
  if (promptEl) promptEl.value = ''
  const prev = getAnkiSettings()
  const next = { ...prev, prompt: '' }
  const changed = Boolean(prev.prompt)
  setAnkiSettings(next)
  const persisted = persistAnkiSettings()
  renderAnkiSettingsInputs()
  if (!persisted) {
    showToast(I18N.toast.anki.promptRestoreFailed)
  } else if (changed) {
    showToast(I18N.toast.anki.promptRestoredDefault)
  }
  DBG('anki:prompt:reset', { changed, persisted })
}

export function saveAnkiSettingsFromInputs() {
  const typeEl = $('anki-api-type')
  const urlEl = $('anki-base-url')
  const modelEl = $('anki-model-id')
  const keyEl = $('anki-api-key')
  const prev = getAnkiSettings()
  const next = {
    apiType: typeEl?.value || prev.apiType,
    baseUrl: (urlEl?.value || '').trim(),
    modelId: (modelEl?.value || '').trim(),
    apiKey: keyEl?.value || ''
  }
  const changed =
    prev.apiType !== next.apiType ||
    prev.baseUrl !== next.baseUrl ||
    prev.modelId !== next.modelId ||
    prev.apiKey !== next.apiKey
  setAnkiSettings(next)
  const persisted = persistAnkiSettings()
  renderAnkiSettingsInputs()
  if (!persisted) {
    showToast(I18N.toast.anki.configSaveFailed)
  } else if (changed) {
    showToast(I18N.toast.anki.configSaved)
  }
  DBG('anki:settings:save', { apiType: next.apiType, changed, persisted })
}

export function bindAnkiSettingsEvents() {
  const saveBtn = $('btn-anki-save')
  saveBtn?.addEventListener('click', saveAnkiSettingsFromInputs)

  const promptSaveBtn = $('btn-anki-prompt-save')
  promptSaveBtn?.addEventListener('click', saveAnkiPromptFromInputs)

  const promptResetBtn = $('btn-anki-prompt-reset')
  promptResetBtn?.addEventListener('click', resetAnkiPrompt)

  const passphraseSaveBtn = $('btn-anki-passphrase-save')
  passphraseSaveBtn?.addEventListener('click', saveAnkiPassphraseFromInputs)

  const passphraseClearBtn = $('btn-anki-passphrase-clear')
  passphraseClearBtn?.addEventListener('click', clearAnkiPassphrase)

  const typeEl = $('anki-api-type')
  const urlEl = $('anki-base-url')
  typeEl?.addEventListener('change', () => {
    const newType = typeEl.value
    const cur = (urlEl?.value || '').trim()
    const prevType = getAnkiSettings().apiType
    const prevDefault = DEFAULT_BASE_URL_FOR_TYPE[prevType]
    if (newType === 'gemini') {
      if (urlEl) {
        urlEl.value = DEFAULT_BASE_URL_FOR_TYPE.gemini
        urlEl.disabled = true
      }
    } else if (urlEl) {
      if (!cur || cur === prevDefault) {
        const nextDefault = DEFAULT_BASE_URL_FOR_TYPE[newType]
        if (nextDefault) urlEl.value = nextDefault
      }
      urlEl.disabled = false
    }
  })

  document.querySelectorAll('.view--settings [data-settings-page]').forEach((item) => {
    item.addEventListener('click', () => {
      if (item.dataset.settingsPage === 'anki-api') {
        renderAnkiSettingsInputs()
      }
    })
  })
}

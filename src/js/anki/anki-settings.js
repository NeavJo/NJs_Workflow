import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N } from '../locales.js'
import { ANKI_API_TYPES } from '../config/storage-config.js'
import {
  getAnkiSettings,
  setAnkiSettings,
  persistAnkiSettings,
  getAnkiProfiles,
  getActiveProfile,
  getActiveProfileId,
  addAnkiProfile,
  updateAnkiProfile,
  duplicateAnkiProfile,
  deleteAnkiProfile,
  setActiveProfile,
  onAnkiSettingsChange
} from './anki-store.js'
import {
  setPassphrase,
  clearPassphrase,
  isPassphraseUnlocked,
  hasRememberedPassphrase,
  getEffectivePassphrase
} from './anki-passphrase.js'
import { hasAnkiProfileCredentials } from '../config/storage-config.js'
import { $ } from '../utils/dom-utils.js'
import { createGuard } from '../utils/guard.js'

/**
 * Anki 多模型档案设置：
 *  - renderAnkiSettingsInputs：渲染档案列表 + 当前选中档案详情 + 提示词 + 口令状态
 *  - saveAnkiSettingsFromInputs：保存当前编辑中的档案
 *  - 档案 CRUD 操作
 *  - bindAnkiSettingsEvents：所有事件绑定（幂等，guard.js）
 *
 * 设计要点：
 *  - 编辑中档案（_editingProfileId）是 UI 本地状态，保存后才写回 store
 *  - 新增/复制/删除直接操作 store，然后刷新列表
 *  - apiType 切换时自动联动 baseUrl（Gemini 固定，OpenAI 可用默认值）
 */

const DEFAULT_BASE_URL_FOR_TYPE = {
  gemini: 'https://generativelanguage.googleapis.com',
  openai: 'https://api.openai.com/v1'
}

/** 当前正在编辑的档案 ID；null 表示跟随 active */
let _editingProfileId = null

/**
 * 把当前 UI 中编辑的档案写回 store（不持久化）。
 * 由列表切换、新增、复制等场景在切换前调用，避免丢失未保存的修改。
 *
 * 单档案场景下用户不会（也不需要）点击档案列表项去"切换"，
 * 此时 _editingProfileId 为 null；若直接 return 会导致表单中已修改的内容
 * 被丢弃、保存时回退到旧值（表现为"点保存被清空"）。
 * 因此这里回退到 active 档案作为编辑目标，保证保存一定写入当前表单内容。
 */
function _commitEditingProfile() {
  const targetId = _editingProfileId || getActiveProfileId()
  if (!targetId) return
  const nameEl = $('anki-profile-name')
  const typeEl = $('anki-api-type')
  const urlEl = $('anki-base-url')
  const modelEl = $('anki-model-id')
  const keyEl = $('anki-api-key')
  const partial = {
    name: (nameEl?.value || '').trim(),
    apiType: typeEl?.value || 'gemini',
    baseUrl: (urlEl?.value || '').trim(),
    modelId: (modelEl?.value || '').trim(),
    apiKey: keyEl?.value || ''
  }
  updateAnkiProfile(targetId, partial)
  _editingProfileId = null
}

/** 在档案列表中查找或创建选中项 */
function _ensureProfileOptions(selectedId) {
  const listEl = $('anki-profile-list')
  if (!listEl) return
  listEl.innerHTML = ''
  const profiles = getAnkiProfiles()
  const activeId = getActiveProfileId()

  if (profiles.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'anki-profile-list__empty'
    empty.textContent = I18N.settings.profileListEmpty
    listEl.appendChild(empty)
    return
  }

  profiles.forEach((profile) => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'anki-profile-item'
    item.dataset.profileId = profile.id
    item.setAttribute('role', 'option')
    item.setAttribute('aria-selected', String(profile.id === activeId))

    const isActive = profile.id === activeId
    const isEditing = profile.id === _editingProfileId
    item.classList.toggle('is-active', isActive)
    item.classList.toggle('is-editing', isEditing)

    // 名称行
    const nameRow = document.createElement('div')
    nameRow.className = 'anki-profile-item__name'

    const nameSpan = document.createElement('span')
    nameSpan.className = 'anki-profile-item__label'
    nameSpan.textContent = profile.name || I18N.settings.profileDefaultName
    nameRow.appendChild(nameSpan)

    if (isActive) {
      const badge = document.createElement('span')
      badge.className = 'anki-profile-item__badge'
      badge.textContent = I18N.settings.profileActiveBadge
      nameRow.appendChild(badge)
    }
    item.appendChild(nameRow)

    // 摘要行：apiType · modelId
    const summaryRow = document.createElement('div')
    summaryRow.className = 'anki-profile-item__summary'
    summaryRow.textContent = [
      profile.apiType === 'gemini' ? I18N.anki.geminiLabel : I18N.anki.openaiLabel,
      profile.modelId
    ].filter(Boolean).join(' · ')
    item.appendChild(summaryRow)

    // 选择该档案：同时作为"编辑目标"与"激活档案"。
    // 激活是全局状态（处理机与德语助手都依赖 activeProfileId），
    // 编辑是本地表单状态；点击档案 = 切 active + 进编辑，符合直觉。
    // external: true 让 Anki 处理机选择器订阅能刷新（本页操作视为"外部"）。
    // 若点击的已是 active，则只进编辑，避免重复持久化。
    item.addEventListener('click', () => {
      _editingProfileId = profile.id
      if (profile.id !== activeId) {
        setActiveProfile(profile.id, { external: true })
      }
      renderAnkiSettingsInputs()
    })

    listEl.appendChild(item)
  })
}

export function renderAnkiSettingsInputs() {
  const settings = getAnkiSettings()
  const activeProfile = getActiveProfile()

  // 确定当前编辑中的档案：优先 _editingProfileId，否则 active
  const editId = _editingProfileId || (activeProfile ? activeProfile.id : null)
  const editProfile = editId
    ? settings.profiles.find((p) => p.id === editId) || activeProfile
    : activeProfile

  // 渲染档案列表
  _ensureProfileOptions(editId)

  // 渲染详情表单
  const nameEl = $('anki-profile-name')
  const typeEl = $('anki-api-type')
  const urlEl = $('anki-base-url')
  const modelEl = $('anki-model-id')
  const keyEl = $('anki-api-key')
  const promptEl = $('anki-prompt-input')
  const promptStatusEl = $('anki-prompt-status')

  if (editProfile) {
    if (nameEl) nameEl.value = editProfile.name || ''
    if (typeEl) {
      if (!typeEl.options.length) {
        for (const t of ANKI_API_TYPES) {
          const opt = document.createElement('option')
          opt.value = t
          opt.textContent = t === 'gemini' ? I18N.anki.geminiLabel : I18N.anki.openaiLabel
          typeEl.appendChild(opt)
        }
      }
      typeEl.value = editProfile.apiType
    }
    if (urlEl) {
      if (editProfile.apiType === 'gemini') {
        urlEl.value = DEFAULT_BASE_URL_FOR_TYPE.gemini
        urlEl.disabled = true
      } else {
        urlEl.value = editProfile.baseUrl || ''
        urlEl.disabled = false
      }
    }
    if (modelEl) modelEl.value = editProfile.modelId || ''
    if (keyEl) keyEl.value = editProfile.apiKey || ''
  }

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
    const hasAnyKey = getAnkiProfiles().some((p) => p.apiKey)
    const noPassphrase = !getEffectivePassphrase()
    hintEl.hidden = !(hasAnyKey && noPassphrase)
  }
}

/* ===== 档案 CRUD ===== */

export function addNewAnkiProfile() {
  _commitEditingProfile()
  const profile = addAnkiProfile({})
  _editingProfileId = profile.id
  // 设为 active 以便表单显示
  setActiveProfile(profile.id)
  renderAnkiSettingsInputs()
  DBG('anki:profile:add:ui', { profileId: profile.id })
}

export function duplicateCurrentAnkiProfile() {
  const targetId = _editingProfileId || getActiveProfileId()
  if (!targetId) return
  _commitEditingProfile()
  const copy = duplicateAnkiProfile(targetId)
  if (!copy) return
  _editingProfileId = copy.id
  renderAnkiSettingsInputs()
  DBG('anki:profile:duplicate:ui', { sourceId: targetId, newId: copy.id })
}

export function deleteCurrentAnkiProfile() {
  const targetId = _editingProfileId || getActiveProfileId()
  if (!targetId) return
  const profiles = getAnkiProfiles()
  if (profiles.length <= 1) {
    showToast(I18N.toast.anki.cannotDeleteLastProfile)
    return
  }
  if (!window.confirm(I18N.toast.anki.deleteProfileConfirm)) return
  _editingProfileId = null
  const result = deleteAnkiProfile(targetId)
  persistAnkiSettings()
  // 删除后刷新列表；如果删除的是 active，activeProfileId 会被 store 重置为首项
  renderAnkiSettingsInputs()
  DBG('anki:profile:delete:ui', { deletedId: targetId, remaining: result.profiles.length })
}

export function saveAnkiSettingsFromInputs() {
  _commitEditingProfile()
  const persisted = persistAnkiSettings()
  _editingProfileId = null
  renderAnkiSettingsInputs()
  if (!persisted) {
    showToast(I18N.toast.anki.configSaveFailed)
  } else {
    showToast(I18N.toast.anki.configSaved)
  }
  DBG('anki:settings:save:ui', { persisted })
}

/* ===== 提示词与口令（保持全局语义） ===== */

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

/* ===== 事件绑定（幂等） ===== */

const guardAnkiSettings = createGuard('ankiSettingsEventsBound')
const guardProfileActions = createGuard('ankiProfileActionsBound')
const guardSubPageNav = createGuard('ankiSubPageNavBound')

export function bindAnkiSettingsEvents() {
  if (guardAnkiSettings.is()) return
  guardAnkiSettings.set()

  // 档案操作按钮
  try {
    const addBtn = $('btn-anki-profile-add')
    addBtn?.addEventListener('click', addNewAnkiProfile)
  } catch (e) {
    DBG('anki:bind:add-profile:fail', String(e))
  }
  try {
    const dupBtn = $('btn-anki-profile-duplicate')
    dupBtn?.addEventListener('click', duplicateCurrentAnkiProfile)
  } catch (e) {
    DBG('anki:bind:duplicate-profile:fail', String(e))
  }
  try {
    const delBtn = $('btn-anki-profile-delete')
    delBtn?.addEventListener('click', deleteCurrentAnkiProfile)
  } catch (e) {
    DBG('anki:bind:delete-profile:fail', String(e))
  }
  try {
    const saveBtn = $('btn-anki-save')
    saveBtn?.addEventListener('click', saveAnkiSettingsFromInputs)
  } catch (e) {
    DBG('anki:bind:save:fail', String(e))
  }

  // 提示词
  try {
    const promptSaveBtn = $('btn-anki-prompt-save')
    promptSaveBtn?.addEventListener('click', saveAnkiPromptFromInputs)
  } catch (e) {
    DBG('anki:bind:prompt-save:fail', String(e))
  }
  try {
    const promptResetBtn = $('btn-anki-prompt-reset')
    promptResetBtn?.addEventListener('click', resetAnkiPrompt)
  } catch (e) {
    DBG('anki:bind:prompt-reset:fail', String(e))
  }

  // 口令
  try {
    const passphraseSaveBtn = $('btn-anki-passphrase-save')
    passphraseSaveBtn?.addEventListener('click', saveAnkiPassphraseFromInputs)
  } catch (e) {
    DBG('anki:bind:passphrase-save:fail', String(e))
  }
  try {
    const passphraseClearBtn = $('btn-anki-passphrase-clear')
    passphraseClearBtn?.addEventListener('click', clearAnkiPassphrase)
  } catch (e) {
    DBG('anki:bind:passphrase-clear:fail', String(e))
  }

  // apiType 联动 baseUrl
  try {
    const typeEl = $('anki-api-type')
    const urlEl = $('anki-base-url')
    typeEl?.addEventListener('change', () => {
      const newType = typeEl.value
      const cur = (urlEl?.value || '').trim()
      if (newType === 'gemini') {
        if (urlEl) {
          urlEl.value = DEFAULT_BASE_URL_FOR_TYPE.gemini
          urlEl.disabled = true
        }
      } else if (urlEl) {
        if (!cur || cur === DEFAULT_BASE_URL_FOR_TYPE.gemini) {
          const nextDefault = DEFAULT_BASE_URL_FOR_TYPE[newType]
          if (nextDefault) urlEl.value = nextDefault
        }
        urlEl.disabled = false
      }
    })
  } catch (e) {
    DBG('anki:bind:type-change:fail', String(e))
  }

  // 档案增删改 / active 切换后即时刷新设置页列表与表单。
  // 仅响应 external: true 的 emit（处理机切 active、外部备份导入），
  // 本页自身操作（点档案切 active、点保存）已通过手动 renderAnkiSettingsInputs() 刷新，
  // 若订阅也响应，会二次重渲染、抹掉用户未保存的表单输入。
  try {
    onAnkiSettingsChange((data) => {
      if (data && data.external) {
        renderAnkiSettingsInputs()
      }
    })
  } catch (e) {
    DBG('anki:bind:settings-subscribe:fail', String(e))
  }
}

/**
 * 子页面导航：进入 anki-api 子页时刷新一次状态。
 * 用 guard 保证不重复绑定。
 */
export function bindAnkiSubPageNav() {
  if (guardSubPageNav.is()) return
  guardSubPageNav.set()
  document.querySelectorAll('.view--settings [data-settings-page]').forEach((item) => {
    item.addEventListener('click', () => {
      if (item.dataset.settingsPage === 'anki-api') {
        _editingProfileId = null
        renderAnkiSettingsInputs()
      }
    })
  })
}

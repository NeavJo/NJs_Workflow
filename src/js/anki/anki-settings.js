import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N } from '../locales.js'
import { ANKI_API_TYPES } from '../config/storage-config.js'
import {
  getAnkiSettings,
  getAnkiProfiles,
  getActiveProfile,
  getActiveProfileId,
  addAnkiProfile,
  updateAnkiProfileWithKey,
  commitAnkiPrompt,
  duplicateAnkiProfile,
  deleteAnkiProfile,
  setActiveProfile,
  onAnkiSettingsChange,
  hydrateAnkiSecrets
} from './anki-store.js'
import {
  setPassphrase,
  clearPassphrase,
  isPassphraseUnlocked,
  hasRememberedPassphrase,
  getEffectivePassphrase
} from './anki-passphrase.js'
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
 *  - 档案保存一律走 updateAnkiProfileWithKey（含明文密钥时先加密，D4 密钥保护）；
 *    表单密钥框不再回显明文（renderAnkiSettingsInputs），仅"留空则不修改"。
 */

const DEFAULT_BASE_URL_FOR_TYPE = {
  gemini: 'https://generativelanguage.googleapis.com',
  openai: 'https://api.openai.com/v1'
}

/** 当前正在编辑的档案 ID；null 表示跟随 active */
let _editingProfileId = null

/**
 * 把当前 UI 中编辑的档案写回 store（含持久化与密钥加密，异步）。
 * 由列表切换、新增、复制等场景在切换前调用，避免丢失未保存的修改。
 *
 * 单档案场景下用户不会（也不需要）点击档案列表项去"切换"，
 * 此时 _editingProfileId 为 null；若直接 return 会导致表单中已修改的内容
 * 被丢弃、保存时回退到旧值（表现为"点保存被清空"）。
 * 因此这里回退到 active 档案作为编辑目标，保证保存一定写入当前表单内容。
 *
 * 密钥处理（D4）：keyEl.value 有值 → 走 updateAnkiProfileWithKey（有口令则加密为 apiKeyEncrypted，
 * 无口令则失败并保持旧状态）；留空 → 不带 apiKey 字段，store 会保留该档案既有密钥。
 * @returns {Promise<boolean>} 是否成功写回（调用方据此决定是否继续切换/新增）
 */
async function _commitEditingProfile() {
  const targetId = _editingProfileId || getActiveProfileId()
  if (!targetId) return false
  const nameEl = $('anki-profile-name')
  const typeEl = $('anki-api-type')
  const urlEl = $('anki-base-url')
  const modelEl = $('anki-model-id')
  const keyEl = $('anki-api-key')
  const partial = {
    name: (nameEl?.value || '').trim(),
    apiType: typeEl?.value || 'gemini',
    baseUrl: (urlEl?.value || '').trim(),
    modelId: (modelEl?.value || '').trim()
  }
  // 密钥仅在用户填写时携带；留空则不传该字段，store 保留原档案密钥。
  const keyValue = (keyEl?.value || '').trim()
  if (keyValue) {
    partial.apiKey = keyValue
  }
  const result = await updateAnkiProfileWithKey(targetId, partial)
  _editingProfileId = null
  return Boolean(result.ok)
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
    // 密钥不回显明文（D4）：仅在"已存有密钥"时给出占位提示，输入框留空，
    // 用户可填写新密钥以覆盖；留空则保存时保留原密钥。
    if (keyEl) {
      keyEl.value = ''
      keyEl.placeholder = editProfile.apiKey || editProfile.apiKeyEncrypted
        ? I18N.settings.apiKeyStoredPlaceholder
        : ''
    }
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

export async function addNewAnkiProfile() {
  await _commitEditingProfile()
  const profile = addAnkiProfile({})
  if (!profile) {
    showToast(I18N.toast.anki.configSaveFailed)
    return
  }
  _editingProfileId = profile.id
  // 设为 active 以便表单显示
  const active = setActiveProfile(profile.id)
  if (!active) {
    showToast(I18N.toast.anki.configSaveFailed)
    return
  }
  renderAnkiSettingsInputs()
  DBG('anki:profile:add:ui', { profileId: profile.id })
}

export async function duplicateCurrentAnkiProfile() {
  const targetId = _editingProfileId || getActiveProfileId()
  if (!targetId) return
  await _commitEditingProfile()
  const copy = duplicateAnkiProfile(targetId)
  if (!copy) {
    showToast(I18N.toast.anki.configSaveFailed)
    return
  }
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
  // 删除是同步的严格一致性提交：store 内部已持久化 + emit，
  // 此处不再重复调用 persistAnkiSettings。
  const result = deleteAnkiProfile(targetId)
  if (!result) {
    showToast(I18N.toast.anki.configSaveFailed)
    return
  }
  // 删除后刷新列表；如果删除的是 active，activeProfileId 会被 store 重置为首项
  renderAnkiSettingsInputs()
  DBG('anki:profile:delete:ui', { deletedId: targetId, remaining: result.profiles.length })
}

export async function saveAnkiSettingsFromInputs() {
  const ok = await _commitEditingProfile()
  _editingProfileId = null
  renderAnkiSettingsInputs()
  if (!ok) {
    showToast(I18N.toast.anki.configSaveFailed)
  } else {
    showToast(I18N.toast.anki.configSaved)
  }
  DBG('anki:settings:save:ui', { ok })
}

/* ===== 提示词与口令（保持全局语义） ===== */

export function saveAnkiPromptFromInputs() {
  const promptEl = $('anki-prompt-input')
  const prev = getAnkiSettings()
  const nextPrompt = (promptEl?.value || '').trim()
  const changed = prev.prompt !== nextPrompt
  // 严格一致性（D2）：提示词不含密钥，走同步 commitAnkiPrompt；
  // 持久化成功才更新内存并 emit，失败则回退输入框、不发布虚假刷新。
  const ok = commitAnkiPrompt(nextPrompt)
  if (promptEl && !ok) promptEl.value = prev.prompt || ''
  renderAnkiSettingsInputs()
  if (!ok) {
    showToast(I18N.toast.anki.promptSaveFailed)
  } else if (changed) {
    showToast(nextPrompt ? I18N.toast.anki.promptSaved : I18N.toast.anki.promptRestored)
  }
  DBG('anki:prompt:save', { changed, hasCustomPrompt: Boolean(nextPrompt), ok })
}

export function resetAnkiPrompt() {
  const promptEl = $('anki-prompt-input')
  if (promptEl) promptEl.value = ''
  const prev = getAnkiSettings()
  const changed = Boolean(prev.prompt)
  // 严格一致性（D2）：持久化成功才清除内存 prompt；失败则回滚输入框。
  const ok = commitAnkiPrompt('')
  if (promptEl && !ok) promptEl.value = prev.prompt || ''
  renderAnkiSettingsInputs()
  if (!ok) {
    showToast(I18N.toast.anki.promptRestoreFailed)
  } else if (changed) {
    showToast(I18N.toast.anki.promptRestoredDefault)
  }
  DBG('anki:prompt:reset', { changed, ok })
}

export async function saveAnkiPassphraseFromInputs() {
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
  if (!ok) {
    showToast(I18N.toast.anki.passphraseSaveFailed)
    DBG('anki:passphrase:save', { remember, ok })
    return
  }
  // 口令生效后立即用其解密已有密文（水合内存明文），
  // 让"已存密钥"在解锁后即刻可运行、可加密上传；异步、不阻塞提示。
  hydrateAnkiSecrets().catch((e) => DBG('anki:passphrase:hydrate:fail', String(e)))
  renderAnkiPassphraseStatus()
  showToast(remember ? I18N.toast.anki.passphraseSavedRemembered : I18N.toast.anki.passphraseSaved)
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

export function bindAnkiSettingsEvents() {
  if (guardAnkiSettings.is()) return

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

  // 各绑定独立 try/catch 完成后统一置位：单次绑定失败不阻断其它模块，
  // 但整轮绑定尝试完成后标记 guard，避免重复调用时二次绑定、产生重复监听。
  guardAnkiSettings.set()
}


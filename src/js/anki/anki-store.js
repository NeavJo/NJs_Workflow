import {
  DEFAULT_ANKI_SETTINGS,
  normalizeAnkiSettings,
  getActiveAnkiProfile,
  hasAnkiProfileCredentials,
  createAnkiProfile,
  normalizeAnkiProfile,
  ANKI_SETTINGS_STORAGE_KEY
} from '../config/storage-config.js'
import { safeStorageGet, safeStorageSet } from '../core/storage.js'
import { DBG } from '../core/debug.js'
import { requestAutoUpload } from '../core/sync-hooks.js'
import { createPubSub } from '../utils/pubsub.js'

/**
 * Anki 处理机配置状态源：profiles / activeProfileId / prompt。
 *  - 每个 profile 保存 apiType / baseUrl / modelId / apiKey / apiKeyEncrypted；
 *    明文 apiKey 仅留在内存与本地存储，上传/导出前由加密模块转为 apiKeyEncrypted。
 *  - activeProfileId 是本地偏好；跨设备导入后若远端 id 不存在，本地 normalize 会回退到首项。
 *  - persistAnkiSettings 只有在本地持久化成功后才触发 requestAutoUpload()，避免虚假同步。
 */

let ankiSettings = normalizeAnkiSettings(safeStorageGet(ANKI_SETTINGS_STORAGE_KEY, DEFAULT_ANKI_SETTINGS))

/* Anki 设置（多档案）变更订阅：档案增删改、激活切换、prompt 修改都会 emit，
 * 用于让主处理页档案选择器与设置页即时刷新（无需整页重载）。 */
const ankiPubsub = createPubSub()

/**
 * 订阅 Anki 设置变更，返回取消订阅函数。
 * @param {(data: object) => void} fn
 * @returns {() => void}
 */
export function onAnkiSettingsChange(fn) {
  return ankiPubsub.on(fn)
}

function summarizeProfileForLog(profile, prefix = 'active') {
  const target = profile && typeof profile === 'object' ? profile : {}
  return {
    [`${prefix}ApiType`]: target.apiType,
    [`${prefix}HasBaseUrl`]: Boolean(target.baseUrl),
    [`${prefix}ModelId`]: target.modelId,
    [`${prefix}HasKey`]: Boolean(target.apiKey),
    [`${prefix}HasEncryptedKey`]: Boolean(target.apiKeyEncrypted)
  }
}

export function loadAnkiSettings() {
  ankiSettings = normalizeAnkiSettings(safeStorageGet(ANKI_SETTINGS_STORAGE_KEY, DEFAULT_ANKI_SETTINGS))
  const activeProfile = getActiveAnkiProfile(ankiSettings)
  DBG('init:ankiSettings', {
    profileCount: ankiSettings.profiles.length,
    activeProfileId: ankiSettings.activeProfileId,
    hasCustomPrompt: Boolean(ankiSettings.prompt),
    ...summarizeProfileForLog(activeProfile)
  })
  return ankiSettings
}

export function getAnkiSettings() {
  return ankiSettings
}

export function setAnkiSettings(next, { emit = true, source = 'settings:set' } = {}) {
  ankiSettings = normalizeAnkiSettings(next)
  if (emit) {
    ankiPubsub.emit({
      profiles: ankiSettings.profiles,
      activeProfileId: ankiSettings.activeProfileId,
      reason: source,
      // source 区分"本页操作"与"外部变更"：设置页订阅仅响应 external，
      // 避免自身操作触发的 emit 二次重渲染、抹掉用户未保存的表单输入。
      external: source === 'external'
    })
  }
  return ankiSettings
}

export function persistAnkiSettings() {
  const ok = safeStorageSet(ANKI_SETTINGS_STORAGE_KEY, ankiSettings)
  const activeProfile = getActiveAnkiProfile(ankiSettings)
  DBG('persist:ankiSettings', {
    profileCount: ankiSettings.profiles.length,
    activeProfileId: ankiSettings.activeProfileId,
    hasCustomPrompt: Boolean(ankiSettings.prompt),
    ok,
    ...summarizeProfileForLog(activeProfile)
  })
  if (ok) requestAutoUpload()
  return ok
}

export function getAnkiProfiles() {
  return ankiSettings.profiles
}

export function getActiveProfile() {
  return getActiveAnkiProfile(ankiSettings)
}

export function getActiveProfileId() {
  const active = getActiveAnkiProfile(ankiSettings)
  return active ? active.id : ''
}

export function hasAnkiCredentials() {
  // 对外保持“当前处理机是否有可运行配置”的语义；
  // 多档案模型下只要当前档案完整即可。
  return hasAnkiProfileCredentials(getActiveAnkiProfile(ankiSettings))
}

export function hasAnyAnkiCredentials() {
  return ankiSettings.profiles.some((profile) => hasAnkiProfileCredentials(profile))
}

export function addAnkiProfile(partial = {}) {
  const profile = createAnkiProfile(partial, ankiSettings.profiles.length)
  ankiSettings = setAnkiSettings({
    ...ankiSettings,
    profiles: [...ankiSettings.profiles, profile]
  }, { emit: false })
  ankiPubsub.emit({ profiles: ankiSettings.profiles, activeProfileId: ankiSettings.activeProfileId, reason: 'profile:add', external: false })
  DBG('anki:profile:add', { profileId: profile.id, name: profile.name })
  return profile
}

export function updateAnkiProfile(profileId, partial = {}) {
  const target = ankiSettings.profiles.find((profile) => profile.id === profileId)
  if (!target) return null
  const updated = normalizeAnkiProfile({
    ...target,
    ...partial,
    id: target.id
  }, ankiSettings.profiles.indexOf(target), target.name)
  ankiSettings = setAnkiSettings({
    ...ankiSettings,
    profiles: ankiSettings.profiles.map((profile, index) =>
      index === ankiSettings.profiles.indexOf(target) ? updated : profile
    )
  }, { emit: false })
  ankiPubsub.emit({ profiles: ankiSettings.profiles, activeProfileId: ankiSettings.activeProfileId, reason: 'profile:update', external: false })
  DBG('anki:profile:update', { profileId: updated.id, name: updated.name })
  return updated
}

export function duplicateAnkiProfile(profileId) {
  const source = ankiSettings.profiles.find((profile) => profile.id === profileId)
  if (!source) return null
  const copy = createAnkiProfile(
    {
      ...source,
      name: `${source.name} 副本`
    },
    ankiSettings.profiles.length
  )
  ankiSettings = setAnkiSettings({
    ...ankiSettings,
    profiles: [...ankiSettings.profiles, copy]
  }, { emit: false })
  ankiPubsub.emit({ profiles: ankiSettings.profiles, activeProfileId: ankiSettings.activeProfileId, reason: 'profile:duplicate', external: false })
  DBG('anki:profile:duplicate', { sourceId: source.id, newId: copy.id })
  return copy
}

export function deleteAnkiProfile(profileId) {
  const exists = ankiSettings.profiles.some((profile) => profile.id === profileId)
  if (!exists) return ankiSettings
  ankiSettings = setAnkiSettings({
    ...ankiSettings,
    profiles: ankiSettings.profiles.filter((profile) => profile.id !== profileId),
    activeProfileId: ankiSettings.activeProfileId === profileId ? '' : ankiSettings.activeProfileId
  }, { emit: false })
  ankiPubsub.emit({ profiles: ankiSettings.profiles, activeProfileId: ankiSettings.activeProfileId, reason: 'profile:delete', external: false })
  DBG('anki:profile:delete', { profileId, profileCount: ankiSettings.profiles.length })
  return ankiSettings
}

export function setActiveProfile(profileId, { external = false } = {}) {
  const target = ankiSettings.profiles.find((profile) => profile.id === profileId)
  if (!target) return null
  // 已是 active 时直接返回，避免无谓持久化
  if (ankiSettings.activeProfileId === target.id) return target

  // 切换 active 是"本地偏好"，内存先生效并 emit，确保 UI 即时响应；
  // 持久化仅尽力而为（localStorage 沙箱/隐私模式下可能失败），失败不回滚，
  // 否则会出现"点了没反应"（回滚使 UI 表现为未切换）。
  ankiSettings = setAnkiSettings({
    ...ankiSettings,
    activeProfileId: target.id
  }, { emit: false })
  const persisted = persistAnkiSettings()
  ankiPubsub.emit({ profiles: ankiSettings.profiles, activeProfileId: ankiSettings.activeProfileId, reason: 'profile:setActive', external })
  DBG('anki:profile:setActive', { profileId: target.id, name: target.name, persisted, external })
  return target
}

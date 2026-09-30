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
import { decryptAnkiSecret, encryptAnkiSecret } from './anki-crypto.js'
import { getEffectivePassphrase, hasRememberedPassphrase, unlockFromRemembered } from './anki-passphrase.js'

/**
 * Anki 处理机配置状态源：profiles / activeProfileId / prompt。
 *
 * 设计约束（与项目规范对齐）：
 *  - 严格一致性（D2）：所有写操作走 commitAnkiSettings —— 先持久化成功，再提交内存并 emit；
 *    持久化失败则内存回滚到旧状态且不发布事件，杜绝"虚假成功刷新"。
 *  - 密钥保护（D4）：任何落盘路径都经过 toPersistableSettings，剔除明文 apiKey，仅保留密文。
 *    明文 apiKey 仅存在于内存，运行时用于请求；启动/解锁/保存后通过 hydrateAnkiSecrets 回填。
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

/**
 * 纯内存 setter：仅供初始化与外部导入流程（backup/events、gist-sync）使用。
 * 这些流程自带独立的持久化与回滚，不纳入本次 commitAnkiSettings 改造。
 */
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

/**
 * 生成写入 localStorage 的投影：剔除明文 apiKey，仅保留密文与其它字段。
 * 这是 D4 的强制约束——任何持久化路径都必须经过本函数，禁止直接序列化含明文的对象。
 * 保留内存中的明文（内存仍用于运行时请求），只影响落盘内容。
 */
function toPersistableSettings(settings) {
  return {
    ...settings,
    profiles: settings.profiles.map((profile) => ({ ...profile, apiKey: '' }))
  }
}

/**
 * 严格一致性提交（同步，唯一非密钥写路径）：
 *  1. 持久化成功（safeStorageSet）是内存提交与 emit 的前提；
 *  2. 失败则内存回滚到 prev，绝不 emit，返回 ok:false，调用方据此提示失败并回退 UI。
 *  适用场景：不改变档案 apiKey 的操作（切换 / 增删 / 复制 / prompt）。
 */
function commitAnkiSettings(next, { reason, external = false } = {}) {
  const prev = ankiSettings
  const candidate = normalizeAnkiSettings(next)
  const ok = safeStorageSet(ANKI_SETTINGS_STORAGE_KEY, toPersistableSettings(candidate))
  const activeProfile = getActiveAnkiProfile(candidate)
  DBG('anki:commit', {
    reason,
    ok,
    profileCount: candidate.profiles.length,
    activeProfileId: candidate.activeProfileId,
    ...summarizeProfileForLog(activeProfile)
  })
  if (!ok) {
    // 持久化失败：内存保持 prev，不 emit、不触发 Gist 上传（避免虚假同步）
    return { ok: false, settings: prev }
  }
  ankiSettings = candidate
  ankiPubsub.emit({
    profiles: ankiSettings.profiles,
    activeProfileId: ankiSettings.activeProfileId,
    reason,
    external
  })
  requestAutoUpload()
  return { ok: true, settings: candidate }
}

/**
 * 密钥保存专用提交（D4 加密优先 + D2 严格一致性）：
 *  入参 next 的 profiles 中，目标档案可能携带内存明文 apiKey（由调用方在内存侧构造，
 *  用于立即运行与 Gist 上传加密）。本函数负责：
 *   - 该档案有明文 apiKey 且已有口令 → 加密为 apiKeyEncrypted；
 *   - 有明文 apiKey 但无口令 → 中止（ok:false, reason:'no-passphrase'），保持旧状态；
 *   - 落盘前经 toPersistableSettings 剔除所有明文 apiKey。
 *  其余档案的明文 apiKey 不会被本函数加密（保持原状，仅落盘剔除）。
 */
async function commitAnkiSettingsWithKey(next, targetProfileId, { reason, external = false } = {}) {
  const prev = ankiSettings
  const passphrase = getEffectivePassphrase()
  const target = next.profiles.find((p) => p.id === targetProfileId)
  const hasPlaintext = target && Boolean(target.apiKey)

  if (hasPlaintext && !passphrase) {
    // 无口令时拒绝把明文密钥写入档案（避免落盘明文、避免上传未加密 Key）
    DBG('anki:commit:no-passphrase', { profileId: targetProfileId })
    return { ok: false, reason: 'no-passphrase', settings: prev }
  }

  let candidate
  if (hasPlaintext && passphrase) {
    // 仅设置目标档案的密文（加密），其余档案原样引用（保留各自内存明文）。
    // 内存保留明文 apiKey 是刻意的：运行时请求与 Gist 上传加密都依赖它；
    // 落盘时才由 toPersistableSettings 统一剔除明文，二者互不干扰。
    // 加密是 async 且必须在 map 回调之外 await（Node 同步 .map 回调无法 await）。
    const encrypted = await encryptAnkiSecret(target.apiKey, passphrase)
    candidate = {
      ...next,
      profiles: next.profiles.map((p) => (p.id === targetProfileId ? { ...p, apiKeyEncrypted: encrypted } : p))
    }
  } else {
    candidate = next
  }

  const ok = safeStorageSet(ANKI_SETTINGS_STORAGE_KEY, toPersistableSettings(candidate))
  const activeProfile = getActiveAnkiProfile(candidate)
  DBG('anki:commit:key', {
    reason,
    ok,
    profileCount: candidate.profiles.length,
    activeProfileId: candidate.activeProfileId,
    encryptedTarget: Boolean(hasPlaintext && passphrase),
    ...summarizeProfileForLog(activeProfile)
  })
  if (!ok) {
    return { ok: false, reason: 'persist-failed', settings: prev }
  }
  ankiSettings = candidate
  ankiPubsub.emit({
    profiles: ankiSettings.profiles,
    activeProfileId: ankiSettings.activeProfileId,
    reason,
    external
  })
  requestAutoUpload()
  return { ok: true, settings: candidate }
}

/**
 * 显式落盘（无状态变更场景，如口令本身不改变 settings）：
 *  只写盘 + 触发 Gist 上传，不修改内存、不 emit。
 *  与 commitAnkiSettings 区分：本函数不承诺"写状态"语义，仅用于把当前内存镜像持久化。
 */
export function persistAnkiSettings() {
  const ok = safeStorageSet(ANKI_SETTINGS_STORAGE_KEY, toPersistableSettings(ankiSettings))
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
  // 对外保持"当前处理机是否有可运行配置"的语义；
  // 多档案模型下只要当前档案完整即可（apiKey 为内存水合后的明文）。
  return hasAnkiProfileCredentials(getActiveAnkiProfile(ankiSettings))
}

export function hasAnyAnkiCredentials() {
  return ankiSettings.profiles.some((profile) => hasAnkiProfileCredentials(profile))
}

export function addAnkiProfile(partial = {}) {
  const profile = createAnkiProfile(partial, ankiSettings.profiles.length)
  const { ok } = commitAnkiSettings({
    ...ankiSettings,
    profiles: [...ankiSettings.profiles, profile]
  }, { reason: 'profile:add' })
  if (!ok) {
    DBG('anki:profile:add:failed', { profileId: profile.id })
    return null
  }
  DBG('anki:profile:add', { profileId: profile.id, name: profile.name })
  return profile
}

export function updateAnkiProfile(profileId, partial = {}) {
  const target = ankiSettings.profiles.find((profile) => profile.id === profileId)
  if (!target) return null
  const hasKeyField = Object.prototype.hasOwnProperty.call(partial, 'apiKey') ||
    Object.prototype.hasOwnProperty.call(partial, 'apiKeyEncrypted')
  // 未显式提供密钥字段时，保留原档案的 apiKey / apiKeyEncrypted，避免误清空用户已存密钥。
  const updated = normalizeAnkiProfile({
    ...target,
    ...partial,
    id: target.id
  }, ankiSettings.profiles.indexOf(target), target.name)
  if (!hasKeyField) {
    // 非密钥路径：杜绝明文密钥随本操作被重新写回内存（D4 不变量）
    updated.apiKey = target.apiKey || ''
    updated.apiKeyEncrypted = target.apiKeyEncrypted || ''
  }
  const { ok } = commitAnkiSettings({
    ...ankiSettings,
    profiles: ankiSettings.profiles.map((profile, index) =>
      index === ankiSettings.profiles.indexOf(target) ? updated : profile
    )
  }, { reason: 'profile:update' })
  if (!ok) return null
  DBG('anki:profile:update', { profileId: updated.id, name: updated.name, hasKeyField })
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
  const { ok } = commitAnkiSettings({
    ...ankiSettings,
    profiles: [...ankiSettings.profiles, copy]
  }, { reason: 'profile:duplicate' })
  if (!ok) return null
  DBG('anki:profile:duplicate', { sourceId: source.id, newId: copy.id })
  return copy
}

/**
 * 密钥保存专用（D4）：构造目标档案（保留原档案 + 变更，内存保留明文 apiKey 供运行/上传），
 * 再走 commitAnkiSettingsWithKey：有口令则把明文加密为 apiKeyEncrypted；无口令则拒绝保存明文。
 *  - 成功：内存含明文 + 密文，落盘仅密文；返回 { ok:true, profile }
 *  - 无口令且本次带明文：返回 { ok:false, reason:'no-passphrase' }，调用方提示"请先设置口令"
 *  - 持久化失败：返回 { ok:false, reason:'persist-failed' }，内存回滚
 */
export async function updateAnkiProfileWithKey(profileId, partial = {}) {
  const target = ankiSettings.profiles.find((profile) => profile.id === profileId)
  if (!target) return { ok: false, reason: 'not-found' }
  const merged = normalizeAnkiProfile({
    ...target,
    ...partial,
    id: target.id
  }, ankiSettings.profiles.indexOf(target), target.name)
  const next = {
    ...ankiSettings,
    profiles: ankiSettings.profiles.map((profile) =>
      profile.id === profileId ? merged : profile
    )
  }
  const result = await commitAnkiSettingsWithKey(next, profileId, { reason: 'profile:update', external: false })
  if (result.ok) {
    DBG('anki:profile:update:key', { profileId: merged.id, name: merged.name })
    return { ok: true, profile: merged }
  }
  return result
}

export function deleteAnkiProfile(profileId) {
  const exists = ankiSettings.profiles.some((profile) => profile.id === profileId)
  if (!exists) return ankiSettings
  const { ok, settings } = commitAnkiSettings({
    ...ankiSettings,
    profiles: ankiSettings.profiles.filter((profile) => profile.id !== profileId),
    activeProfileId: ankiSettings.activeProfileId === profileId ? '' : ankiSettings.activeProfileId
  }, { reason: 'profile:delete' })
  if (!ok) return null
  DBG('anki:profile:delete', { profileId, profileCount: settings.profiles.length })
  return settings
}

export function setActiveProfile(profileId, { external = false } = {}) {
  const target = ankiSettings.profiles.find((profile) => profile.id === profileId)
  if (!target) return null
  // 已是 active 时直接返回，避免无谓持久化
  if (ankiSettings.activeProfileId === target.id) return target
  // 严格一致性（D2）：持久化成功才提交；失败则 UI 不变并提示，杜绝"点了没反应"的假切换。
  const { ok } = commitAnkiSettings({
    ...ankiSettings,
    activeProfileId: target.id
  }, { reason: 'profile:setActive', external })
  if (!ok) {
    DBG('anki:profile:setActive:failed', { profileId: target.id, external })
    return null
  }
  DBG('anki:profile:setActive', { profileId: target.id, name: target.name, external })
  return target
}

/**
 * 提示词严格一致性提交（D2）：prompt 不含密钥，走同步 commitAnkiSettings。
 *  持久化成功才更新内存 + emit；失败则保持旧状态并返回 false，调用方据此回退输入框。
 * @returns {boolean} 是否成功持久化
 */
export function commitAnkiPrompt(nextPrompt) {
  const ok = commitAnkiSettings({
    ...ankiSettings,
    prompt: nextPrompt || ''
  }, { reason: 'prompt:save' }).ok
  if (!ok) {
    DBG('anki:prompt:commit:failed', { prompt: nextPrompt })
  }
  return ok
}

/**
 * 内存密钥水合（D4）：用当前有效口令解密各档案 apiKeyEncrypted → 填充内存明文 apiKey（不落盘）。
 *  触发时机：启动、解锁口令后、导入/拉取后。
 *  无口令或解密失败时跳过该档案（其运行时视为无凭证），不影响其它数据。
 * @returns {Promise<{hydrated: number, skipped: number, hasPassphrase: boolean}>}
 */
export async function hydrateAnkiSecrets() {
  const passphrase = getEffectivePassphrase()
  const state = { hydrated: 0, migrated: 0, skipped: 0, hasPassphrase: Boolean(passphrase) }
  if (!passphrase) {
    DBG('anki:hydrate:skip', { reason: 'no-passphrase', profileCount: ankiSettings.profiles.length })
    return state
  }
  const next = normalizeAnkiSettings({
    ...ankiSettings,
    profiles: ankiSettings.profiles.map((profile) => ({ ...profile }))
  })
  let needsPersist = false
  for (const profile of next.profiles) {
    if (profile.apiKey && !profile.apiKeyEncrypted) {
      try {
        profile.apiKeyEncrypted = await encryptAnkiSecret(profile.apiKey, passphrase)
        needsPersist = true
        state.migrated += 1
      } catch (err) {
        profile.apiKey = ''
        state.skipped += 1
        DBG('anki:hydrate:migrate:fail', { profileId: profile.id, error: String(err) })
        continue
      }
    }
    if (!profile.apiKeyEncrypted) {
      profile.apiKey = ''
      state.skipped += 1
      continue
    }
    let decrypted
    try {
      decrypted = await decryptAnkiSecret(profile.apiKeyEncrypted, passphrase)
    } catch {
      // 口令错误或密文被篡改（AES-GCM 认证失败）：跳过该档案，不影响其它数据
      profile.apiKey = ''
      state.skipped += 1
      continue
    }
    profile.apiKey = decrypted || ''
    state.hydrated += 1
  }
  ankiSettings = next
  if (needsPersist) {
    const ok = safeStorageSet(ANKI_SETTINGS_STORAGE_KEY, toPersistableSettings(ankiSettings))
    if (!ok) DBG('anki:hydrate:migrate:persist-fail')
  }
  DBG('anki:hydrate', state)
  return state
}

/**
 * 启动时自动解锁并水合密钥：有"记住的口令"则尝试解锁后 hydrate。
 *  供 app.js 在 loadAnkiSettings() 之后、autoPullOnStartup 之前调用。
 * @returns {Promise<boolean>} 是否成功解锁（无记住口令时返回 false，不视为错误）
 */
export async function autoHydrateOnStartup() {
  if (!hasRememberedPassphrase()) return false
  const unlocked = unlockFromRemembered()
  if (unlocked) {
    await hydrateAnkiSecrets()
  }
  return unlocked
}

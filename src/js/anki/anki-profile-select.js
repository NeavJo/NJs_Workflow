import { DBG } from '../core/debug.js'
import { $ } from '../utils/dom-utils.js'
import { createGuard } from '../utils/guard.js'
import { I18N } from '../locales.js'
import { showToast } from '../ui.js'
import {
  getAnkiProfiles,
  getActiveProfile,
  getActiveProfileId,
  setActiveProfile,
  onAnkiSettingsChange
} from './anki-store.js'

/**
 * Anki 主处理页档案选择器（#anki-profile-select + #anki-profile-menu）：
 *  - renderAnkiProfileSelect：刷新摘要标签与菜单项
 *  - bindAnkiProfileSelectEvents：点击开合、外部点击收起、菜单项选择（幂等，guard.js）
 *
 * 设计要点：
 *  - 无档案时禁用按钮、隐藏菜单，并显示默认提示。
 *  - 档案增删改 / 激活切换 / 备份导入后通过 onAnkiSettingsChange 即时刷新。
 */

function profileSummary(profile) {
  // 菜单摘要只展示模型 ID，不再显示 API 接口类型（用户要求）；
  // 档案名已由 __name 行展示，此处不重复。
  return profile.modelId || ''
}

function profileDisplayName(profile) {
  return profile.name || I18N.settings.profileDefaultName
}

export function renderAnkiProfileSelect() {
  const buttonEl = $('anki-profile-select')
  if (!buttonEl) return

  const labelEl = $('anki-profile-select-label')
  const menuEl = $('anki-profile-menu')
  const profiles = getAnkiProfiles()
  const activeId = getActiveProfileId()
  const activeProfile = getActiveProfile()

  // 摘要标签
  if (labelEl) {
    labelEl.textContent = activeProfile ? profileDisplayName(activeProfile) : I18N.anki.profileSelectPlaceholder
  }

  // 无档案时禁用并隐藏菜单
  buttonEl.disabled = profiles.length === 0
  if (!menuEl) return
  menuEl.innerHTML = ''
  if (profiles.length === 0) {
    menuEl.hidden = true
    buttonEl.setAttribute('aria-expanded', 'false')
    return
  }

  profiles.forEach((profile) => {
    const item = document.createElement('button')
    item.type = 'button'
    item.role = 'menuitemradio'
    item.className = 'anki-profile-menu__item'
    item.dataset.profileId = profile.id
    item.setAttribute('aria-checked', String(profile.id === activeId))

    const checkIcon = document.createElement('span')
    checkIcon.className = 'material-symbols anki-profile-menu__check'
    checkIcon.textContent = profile.id === activeId ? 'check' : ''
    checkIcon.hidden = profile.id !== activeId

    const body = document.createElement('div')
    body.className = 'anki-profile-menu__body'

    const nameRow = document.createElement('div')
    nameRow.className = 'anki-profile-menu__name'
    nameRow.textContent = profileDisplayName(profile)
    body.appendChild(nameRow)

    const summaryRow = document.createElement('div')
    summaryRow.className = 'anki-profile-menu__summary'
    const summaryText = profileSummary(profile)
    summaryRow.textContent = summaryText
    // 无模型 ID 时隐藏摘要行，避免留白占位
    summaryRow.hidden = !summaryText
    body.appendChild(summaryRow)

    item.appendChild(checkIcon)
    item.appendChild(body)

    item.addEventListener('click', () => {
      openAnkiProfileMenu(false)
      selectAnkiProfile(profile.id)
    })

    menuEl.appendChild(item)
  })
}

function selectAnkiProfile(id) {
  // external: true 让设置页订阅刷新（本页操作），同时 Anki 处理机订阅也刷新
  const active = setActiveProfile(id, { external: true })
  if (!active) {
    renderAnkiProfileSelect()
    showToast(I18N.toast.anki.configSaveFailed)
    return
  }
  renderAnkiProfileSelect()
  DBG('anki:profile-select:change', { id })
}

export function openAnkiProfileMenu(open) {
  const buttonEl = $('anki-profile-select')
  const menuEl = $('anki-profile-menu')
  if (!buttonEl || !menuEl) return
  if (buttonEl.disabled) {
    menuEl.hidden = true
    buttonEl.setAttribute('aria-expanded', 'false')
    buttonEl.classList.remove('is-open')
    return
  }
  menuEl.hidden = !open
  buttonEl.setAttribute('aria-expanded', String(open))
  buttonEl.classList.toggle('is-open', open)
}

const guardProfileSelect = createGuard('ankiProfileSelectBound')

export function bindAnkiProfileSelectEvents() {
  if (guardProfileSelect.is()) return
  guardProfileSelect.set()

  // 开合按钮：点击时切换菜单开合。
  // 逻辑：菜单当前 hidden=true → 打开（传 true）；hidden=false → 关闭（传 false）。
  // 注意 openAnkiProfileMenu 参数语义是"要打开还是关闭"，与 menuEl.hidden 的布尔值相反，
  // 因此必须用 menuEl.hidden（而非 !menuEl.hidden）作为入参。
  try {
    const buttonEl = $('anki-profile-select')
    buttonEl?.addEventListener('click', (e) => {
      e.stopPropagation()
      const menuEl = $('anki-profile-menu')
      if (buttonEl.disabled) return
      openAnkiProfileMenu(menuEl?.hidden ?? true)
    })
  } catch (e) {
    DBG('anki:bind:profile-select:toggle:fail', String(e))
  }

  // 点击外部收起菜单
  try {
    document.addEventListener('click', (e) => {
      const buttonEl = $('anki-profile-select')
      const menuEl = $('anki-profile-menu')
      if (!buttonEl || !menuEl || menuEl.hidden) return
      const picker = buttonEl.closest('.anki-profile-picker')
      if (picker && picker.contains(e.target)) return
      openAnkiProfileMenu(false)
    })
  } catch (e) {
    DBG('anki:bind:profile-select:outside:fail', String(e))
  }

  // Esc 关闭
  try {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') openAnkiProfileMenu(false)
    })
  } catch (e) {
    DBG('anki:bind:profile-select:esc:fail', String(e))
  }

  // 档案增删改 / 激活切换 / 备份导入后即时刷新摘要与菜单
  onAnkiSettingsChange(() => {
    renderAnkiProfileSelect()
  })
}

export function initAnkiProfileSelect() {
  renderAnkiProfileSelect()
  bindAnkiProfileSelectEvents()
}

import { DBG } from '../core/debug.js'
import { closeModal, openModal, registerModalCloseCleanup } from './modal.js'
import { getUserSettings, setUserSettings, persistUserSettings } from '../core/settings-store.js'
import { createGuard } from '../utils/guard.js'

/**
 * 高级视觉效果：存储开关、body 类切换、开启密码锁、参数面板。
 *
 * 为什么独立成模块：
 *  - 该功能已从设置页迁到主页圆盘菜单（workflow/quick-menu.js），入口变了但实现只能有一份；
 *  - 圆盘菜单与密码锁弹窗、参数弹窗分属不同 DOM 区域，集中在这里可保证
 *    「写存储 → 切 body 类 → 通知入口刷新激活态」永远按同一顺序发生。
 *
 * 约束：
 *  - 开启属于受控动作：必须先通过密码校验，禁止任何入口绕过 openAdvancedVisualLock。
 *  - 关闭不需要密码；关闭时必须同时清理卡片上的悬停粒子，避免残留 DOM 与动画。
 */

const ADVANCED_VISUAL_PASSWORD = '0404'

// 开关变化订阅：圆盘菜单据此刷新子项激活态（避免入口自己轮询存储）。
const changeListeners = new Set()

const lockGuard = createGuard('advancedVisualLockBound')
const paramsEntryGuard = createGuard('advancedVisualParamsEntryBound')
const paramsInputsGuard = createGuard('advancedVisualParamsInputsBound')

export function isAdvancedVisualEnabled() {
  return Boolean(getUserSettings().advancedVisual)
}

/**
 * 订阅开关变化。返回取消订阅函数，便于入口销毁时清理。
 */
export function onAdvancedVisualChange(callback) {
  if (typeof callback !== 'function') return () => {}
  changeListeners.add(callback)
  return () => {
    changeListeners.delete(callback)
  }
}

function notifyChange(enabled) {
  for (const callback of [...changeListeners]) {
    try {
      callback(enabled)
    } catch (e) {
      // 单个订阅者出错不能让开关本身失败，也不能阻断其它订阅者。
      DBG('advanced-visual:listener-failed', String(e))
    }
  }
}

export function applyAdvancedVisualBodyClass(enabled) {
  document.body.classList.toggle('is-advanced-visual', Boolean(enabled))
  if (enabled) return
  // 关闭时必须清理悬停激活态与残留粒子，避免关闭后仍保留 DOM 与后续动画状态。
  document.querySelectorAll('.workflow-card.is-pointer-active').forEach((card) => {
    card.classList.remove('is-pointer-active')
    const layer = card.querySelector('.workflow-card__particles')
    if (!layer) return
    const simulation = layer.workflowFairySimulation
    if (simulation) {
      // 先停掉待执行的跟随帧，避免关闭后仍有一帧渲染开销。
      simulation.active = false
      cancelAnimationFrame(simulation.raf)
    }
    layer.style.transform = ''
    layer.replaceChildren()
    delete layer.workflowFairySimulation
  })
}

export function setAdvancedVisualEnabled(enabled) {
  const next = { ...getUserSettings(), advancedVisual: Boolean(enabled) }
  setUserSettings(next)
  persistUserSettings()
  applyAdvancedVisualBodyClass(Boolean(enabled))
  notifyChange(Boolean(enabled))
  DBG('advanced-visual:set', { enabled: Boolean(enabled) })
}

function resetLockState() {
  const lockInput = document.getElementById('advanced-visual-lock-input')
  const error = document.getElementById('advanced-visual-lock-error')
  if (lockInput) lockInput.value = ''
  if (error) error.hidden = true
}

/**
 * 打开开启密码弹窗。只有密码校验通过后才会真正开启特效。
 */
export function openAdvancedVisualLock() {
  const lockInput = document.getElementById('advanced-visual-lock-input')
  const error = document.getElementById('advanced-visual-lock-error')
  if (lockInput) lockInput.value = ''
  if (error) error.hidden = true
  // 每次打开都注册一次关闭清理，保证遮罩/Esc/取消关闭后输入与错误提示被重置。
  registerModalCloseCleanup('advancedVisualLock', resetLockState)
  openModal('advancedVisualLock')
  // openModal 会把焦点放到第一个可聚焦元素（关闭按钮），这里延后拉回密码输入框。
  setTimeout(() => {
    const input = document.getElementById('advanced-visual-lock-input')
    if (input) input.focus({ preventScroll: true })
  }, 220)
}

function bindLockDialog() {
  const lockConfirm = document.getElementById('advanced-visual-lock-confirm')
  const lockInput = document.getElementById('advanced-visual-lock-input')
  if (!lockConfirm || !lockInput) return
  if (lockGuard.is(lockConfirm)) return
  lockGuard.set(lockConfirm)

  const lockError = document.getElementById('advanced-visual-lock-error')
  const submitLock = () => {
    if (lockInput.value.trim() !== ADVANCED_VISUAL_PASSWORD) {
      if (lockError) lockError.hidden = false
      lockInput.focus({ preventScroll: true })
      DBG('advanced-visual:lock', { result: 'denied' })
      return
    }
    setAdvancedVisualEnabled(true)
    resetLockState()
    closeModal('advancedVisualLock')
    DBG('advanced-visual:lock', { result: 'granted' })
  }
  lockConfirm.addEventListener('click', submitLock)
  lockInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submitLock()
    }
  })
  // 用户重新输入时先收起错误提示，避免错误状态一直停留。
  lockInput.addEventListener('input', () => {
    if (lockError) lockError.hidden = true
  })
}

/**
 * 参数面板入口：任何带 data-visual-params-open 的按钮都能打开同一份参数弹窗。
 * 用属性选择器而不是固定 id，入口后续再搬家也不用改这里。
 */
function bindParamsEntries() {
  document.querySelectorAll('[data-visual-params-open]').forEach((btn) => {
    if (paramsEntryGuard.is(btn)) return
    paramsEntryGuard.set(btn)
    btn.addEventListener('click', () => {
      fillParamsInputs()
      btn.setAttribute('aria-expanded', 'true')
      registerModalCloseCleanup('visualParams', () => btn.setAttribute('aria-expanded', 'false'))
      openModal('visualParams')
    })
  })
}

function fillParamsInputs() {
  const inputs = [
    ['workflow-border-particle-speed', 'workflowBorderParticleSpeed'],
    ['workflow-fairy-drift-speed', 'workflowFairyDriftSpeed'],
    ['workflow-fairy-chase-speed', 'workflowFairyChaseSpeed']
  ]
  inputs.forEach(([id, key]) => {
    const input = document.getElementById(id)
    if (input) input.value = Number(getUserSettings()[key] ?? 1).toFixed(2)
  })
}

/**
 * 绑定单个速率输入：回车 / 失焦保存，非法输入回退到已存值，统一收敛到 0.01–10。
 */
function bindSpeedInput(input, storageKey, dbgLabel) {
  if (!input) return
  const fallbackValue = () => Number(getUserSettings()[storageKey] ?? 1).toFixed(2)
  const save = () => {
    if (input.value === '') return
    const raw = Number(input.value)
    if (!Number.isFinite(raw)) {
      input.value = fallbackValue()
      return
    }
    const speed = Math.min(10, Math.max(0.01, raw))
    input.value = speed.toFixed(2)
    const next = { ...getUserSettings(), [storageKey]: speed }
    setUserSettings(next)
    persistUserSettings()
    DBG('advanced-visual:' + dbgLabel, { speed })
  }
  input.addEventListener('change', save)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      save()
      input.blur()
    }
  })
  input.addEventListener('blur', () => {
    if (input.value === '') {
      input.value = fallbackValue()
    } else {
      save()
    }
  })
}

function bindParamsInputs() {
  const speedInput = document.getElementById('workflow-border-particle-speed')
  const driftInput = document.getElementById('workflow-fairy-drift-speed')
  const chaseInput = document.getElementById('workflow-fairy-chase-speed')
  if (!speedInput && !driftInput && !chaseInput) return
  const host = speedInput || driftInput || chaseInput
  if (paramsInputsGuard.is(host)) return
  paramsInputsGuard.set(host)

  bindSpeedInput(speedInput, 'workflowBorderParticleSpeed', 'workflowBorderParticleSpeed')
  bindSpeedInput(driftInput, 'workflowFairyDriftSpeed', 'workflowFairyDriftSpeed')
  bindSpeedInput(chaseInput, 'workflowFairyChaseSpeed', 'workflowFairyChaseSpeed')
}

/**
 * 绑定密码锁弹窗与参数面板。幂等，可重复调用（各子块独立守卫）。
 */
export function bindAdvancedVisualControls() {
  bindLockDialog()
  bindParamsEntries()
  bindParamsInputs()
  DBG('advanced-visual:bound')
}

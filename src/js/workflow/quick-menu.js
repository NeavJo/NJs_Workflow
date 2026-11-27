import { DBG } from '../core/debug.js'
import { I18N, t } from '../locales.js'
import { createGuard } from '../utils/guard.js'
import { getCurrentView, onViewChange } from '../settings/navigation.js'
import {
  isAdvancedVisualEnabled,
  onAdvancedVisualChange,
  openAdvancedVisualLock,
  setAdvancedVisualEnabled
} from '../settings/advanced-visual.js'
import { getSnoozedIds, onSnoozeChange } from './snooze-store.js'
import { openSnoozeModal } from './snooze-events.js'

/**
 * 主页圆盘菜单（flow 页右下角悬浮钮）
 *  - 两个子项：高级视觉效果、今日临时搁置，向上扇形展开，交错入场。
 *  - 子项不复制业务逻辑：
 *      高级视觉 → settings/advanced-visual.js（密码锁 + 开关 + 参数面板）
 *      今日搁置 → workflow/snooze-events.js 的 openSnoozeModal（原搁置弹窗）
 *  - 仅 flow 视图可见：切换视图时关闭扇面并隐藏，同时给 body 打标记，
 *    让桌面端通知条为圆钮让位（避免真实遮挡）。
 */

const quickMenuGuard = createGuard('quickMenuBound')

function getRoot() {
  return document.getElementById('quick-menu')
}

function isFanOpen(root) {
  return Boolean(root && root.classList.contains('is-open'))
}

/**
 * 展开 / 收起扇面。展开前先刷新激活态，保证看到的是当前状态。
 */
function setFanOpen(open) {
  const root = getRoot()
  if (!root) return
  const toggle = document.getElementById('quick-menu-toggle')
  root.classList.toggle('is-open', open)
  if (toggle) {
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false')
    toggle.setAttribute('aria-label', open ? I18N.quickMenu.hubClose : I18N.quickMenu.hubOpen)
  }
  if (open) renderQuickMenuState()
  DBG('quick-menu:fan', { open })
}

/**
 * 刷新两个子项的激活态与副标文案。
 *  - 高级视觉开启时高亮，并显示参数入口（参数只对已开启的特效有意义）。
 *  - 今日有搁置记录时高亮，副标显示搁置条数。
 */
export function renderQuickMenuState() {
  const root = getRoot()
  if (!root) return

  const advancedItem = root.querySelector('.quick-menu__item--advanced')
  const advancedMain = document.getElementById('quick-menu-advanced-visual')
  const advancedHint = document.getElementById('quick-menu-advanced-visual-hint')
  const paramsBtn = document.getElementById('quick-menu-params')
  const advancedOn = isAdvancedVisualEnabled()
  if (advancedItem) advancedItem.classList.toggle('is-active', advancedOn)
  if (advancedMain) advancedMain.setAttribute('aria-checked', advancedOn ? 'true' : 'false')
  if (advancedHint) {
    advancedHint.textContent = advancedOn
      ? I18N.quickMenu.advancedVisualHintOn
      : I18N.quickMenu.advancedVisualHintOff
  }
  if (paramsBtn) paramsBtn.hidden = !advancedOn

  const snoozeItem = root.querySelector('.quick-menu__item--snooze')
  const snoozeHint = document.getElementById('quick-menu-snooze-hint')
  const snoozedCount = getSnoozedIds().size
  if (snoozeItem) snoozeItem.classList.toggle('is-active', snoozedCount > 0)
  if (snoozeHint) {
    snoozeHint.textContent = snoozedCount > 0
      ? t(I18N.quickMenu.snoozeHintActive, { count: snoozedCount })
      : I18N.quickMenu.snoozeHintIdle
  }
}

function syncQuickMenuVisibility() {
  const root = getRoot()
  if (!root) return
  const visible = getCurrentView() === 'flow'
  root.hidden = !visible
  // 桌面端通知条固定在右下角，与圆钮同区域；仅在圆钮可见时抬高，其它视图保持原位。
  document.body.classList.toggle('quick-menu-visible', visible)
  if (!visible) {
    setFanOpen(false)
    return
  }
  renderQuickMenuState()
}

/**
 * 绑定圆盘菜单。幂等；任何子元素缺失都安全跳过。
 */
export function bindQuickMenuEvents() {
  const root = getRoot()
  if (!root) {
    DBG('quick-menu:bind:no-root')
    return
  }
  if (quickMenuGuard.is(root)) return
  quickMenuGuard.set(root)

  const toggle = document.getElementById('quick-menu-toggle')
  const scrim = root.querySelector('.quick-menu__scrim')
  const advancedMain = document.getElementById('quick-menu-advanced-visual')
  const snoozeBtn = document.getElementById('quick-menu-snooze')

  if (toggle) {
    toggle.addEventListener('click', () => setFanOpen(!isFanOpen(root)))
  }
  if (scrim) {
    scrim.addEventListener('click', () => setFanOpen(false))
  }
  if (advancedMain) {
    advancedMain.addEventListener('click', () => {
      if (isAdvancedVisualEnabled()) {
        // 关闭不需要密码，直接落库并刷新激活态。
        setAdvancedVisualEnabled(false)
        renderQuickMenuState()
        return
      }
      // 开启是受控动作：先收起扇面，再走既有的密码锁弹窗（校验通过后由模块内部开启）。
      setFanOpen(false)
      openAdvancedVisualLock()
    })
  }
  if (snoozeBtn) {
    snoozeBtn.addEventListener('click', () => {
      setFanOpen(false)
      openSnoozeModal()
    })
  }

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (!isFanOpen(getRoot())) return
    // 有弹窗时 Esc 归弹窗处理，这里不抢关闭动作，避免一次按键关两层。
    if (document.body.classList.contains('modal-open')) return
    setFanOpen(false)
  })

  // 搁置保存成功后（弹窗内确认）激活态要立刻反映到子项上。
  onSnoozeChange(() => renderQuickMenuState())
  onAdvancedVisualChange(() => renderQuickMenuState())
  onViewChange(() => syncQuickMenuVisibility())

  syncQuickMenuVisibility()
  DBG('quick-menu:bound')
}

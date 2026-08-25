import { DBG } from '../core/debug.js'
import { updateProgress } from '../ui.js'
import { I18N, t } from '../locales.js'
import { getWorkflows } from './workflow-store.js'
import { getCompletedIds } from './completion-store.js'
import { evaluateTaskRuntime, isTaskTrackable, getTrackableTasks } from './workflow-runtime.js'
import { refreshWorkflowCarousel } from './workflow-carousel.js'

/**
 * 工作流渲染层：只读 stores，产出 DOM；不写状态、不绑定事件。
 * 事件绑定交给 workflow-events.js，状态写入交给各 store。
 */

// 背景图标池（Material Symbols）
const BG_ICON_POOL = ['task_alt', 'menu_book', 'translate', 'headphones', 'edit_note', 'auto_awesome', 'schedule', 'event_available', 'school', 'psychology']
// 会话内缓存：item.id -> iconName
const BG_ICON_CACHE = new Map()
let lastUsedIcon = null

function getCardBgIcon(itemId) {
  if (!itemId) return BG_ICON_POOL[0]
  if (BG_ICON_CACHE.has(itemId)) return BG_ICON_CACHE.get(itemId)

  let availablePool = BG_ICON_POOL.filter(icon => icon !== lastUsedIcon)
  // 如果剩余池为空（极端情况），回退到完整池
  if (availablePool.length === 0) availablePool = BG_ICON_POOL

  const icon = availablePool[Math.floor(Math.random() * availablePool.length)]
  lastUsedIcon = icon
  BG_ICON_CACHE.set(itemId, icon)
  return icon
}

function buildBgIconHtml(itemId) {
  const iconName = getCardBgIcon(itemId)
  return `<span class="material-symbols workflow-card__bg-icon" aria-hidden="true">${iconName}</span>`
}

function buildDynamicTagHtml(tagInfo) {
  if (!tagInfo) return ''
  const variantClass = tagInfo.variant === 'muted' ? 'dynamic-tag--muted' : 'dynamic-tag--accent'
  const iconHtml = tagInfo.icon ? `<span class="material-symbols dynamic-tag__icon" aria-hidden="true">${tagInfo.icon}</span>` : ''
  return `<div class="dynamic-tag ${variantClass}">${iconHtml}<span class="dynamic-tag__label"></span></div>`
}

function hydrateDynamicTag(root, tagInfo) {
  if (!tagInfo) return false
  const label = root.querySelector('.dynamic-tag__label')
  if (label) label.textContent = tagInfo.label
  return true
}

function createCard(rawItem, order) {
  const card = document.createElement('article')
  card.id = `workflow-card-${rawItem.id}`
  card.dataset.itemId = rawItem.id
  const completedIds = getCompletedIds()
  const isComplete = completedIds.has(rawItem.id)
  const { tagInfo, disabled } = evaluateTaskRuntime(rawItem)

  if (rawItem.isPlaceholder) {
    card.className = 'workflow-card is-placeholder'
    card.innerHTML = `
      ${buildBgIconHtml(rawItem.id)}
      <div class="order-badge" aria-hidden="true"></div>
      <div class="workflow-card__content">
        <div class="workflow-card__title-row">
          <h3 class="workflow-card__title"></h3>
          <span class="coming-soon-chip">${I18N.workflow.comingSoon}</span>
        </div>
        <p class="workflow-card__description"></p>
      </div>
      <label class="checkbox-wrapper">
        <input type="checkbox" disabled aria-label="${rawItem.title}" />
        <span class="checkbox-mark"><span class="material-symbols" aria-hidden="true">lock</span></span>
      </label>`
    card.querySelector('.order-badge').textContent = String(order).padStart(2, '0')
    card.querySelector('.workflow-card__title').textContent = rawItem.title
    card.querySelector('.workflow-card__description').textContent = rawItem.desc || ''
    return card
  }

  const cardClasses = ['workflow-card']
  if (disabled) cardClasses.push('is-disabled')
  if (isComplete && !disabled) cardClasses.push('is-complete')
  card.className = cardClasses.join(' ')

  const checkEnabled = Boolean(rawItem.checkConfig?.enabled)
  const effectiveDesc = (rawItem.desc && rawItem.desc.trim())
    ? rawItem.desc
    : (checkEnabled
        ? t(I18N.workflow.descFallback, { category: rawItem.checkConfig.category || I18N.workflow.defaultCategory, count: rawItem.checkConfig.targetCount })
        : rawItem.desc)

  const checkboxLocked = disabled || checkEnabled
  const checkboxAttrs = checkboxLocked
    ? `disabled aria-label="${rawItem.title}" ${checkEnabled && isComplete ? 'checked' : ''}`
    : `data-item-id="${rawItem.id}" ${isComplete ? 'checked' : ''} aria-label="${rawItem.title}"`

  let checkIcon = ''
  if (isComplete) {
    checkIcon = 'check'
  } else if (disabled) {
    checkIcon = tagInfo?.icon || 'lock'
  } else {
    checkIcon = ''
  }
  if (checkEnabled) cardClasses.push('has-check-lock')
  card.className = cardClasses.join(' ')

  const jumpButtonHtml = rawItem.url
    ? `<a class="workflow-card__action" href="${rawItem.url}" target="_blank" rel="noopener noreferrer" aria-label="跳转：${rawItem.title}"><span class="material-symbols" aria-hidden="true">open_in_new</span></a>`
    : ''
  const checkButtonHtml = checkEnabled
    ? `<button class="workflow-card__check-btn" type="button" data-check-action="memo-count" data-item-id="${rawItem.id}" aria-label="检查并打卡：${rawItem.title}"><span class="material-symbols" aria-hidden="true">fact_check</span><span class="workflow-card__check-btn__label">检查</span></button>`
    : ''
  const actionAreaHtml = jumpButtonHtml || checkButtonHtml
    ? `<div class="workflow-card__action-area">${jumpButtonHtml}${checkButtonHtml}</div>`
    : ''

  const tagBlockHtml = buildDynamicTagHtml(tagInfo)
  const descriptionHtml = effectiveDesc ? `<p class="workflow-card__description"></p>` : ''

  card.innerHTML = `
    ${buildBgIconHtml(rawItem.id)}
    <div class="order-badge" aria-hidden="true"></div>
    <div class="workflow-card__content">
      <h3 class="workflow-card__title"></h3>
      ${descriptionHtml}
      ${tagBlockHtml}
    </div>
    ${actionAreaHtml}
    <label class="checkbox-wrapper">
      <input type="checkbox" ${checkboxAttrs} />
      <span class="checkbox-mark"><span class="material-symbols" aria-hidden="true">${checkIcon}</span></span>
    </label>`

  card.querySelector('.order-badge').textContent = String(order).padStart(2, '0')
  card.querySelector('.workflow-card__title').textContent = rawItem.title
  const descEl = card.querySelector('.workflow-card__description')
  if (descEl) descEl.textContent = effectiveDesc || ''
  hydrateDynamicTag(card, tagInfo)
  return card
}

export function renderWorkflow() {
  const list = document.querySelector('#workflow-list')
  if (!list) return
  const workflows = getWorkflows()
  const trackableTasks = getTrackableTasks()
  list.replaceChildren(...workflows.map((item, index) => createCard(item, index + 1)))
  const completed = trackableTasks.filter((t) => getCompletedIds().has(t.id)).length
  DBG('render:workflow', { completed, total: trackableTasks.length })
  updateProgress(completed, trackableTasks.length)
  refreshWorkflowCarousel()
}

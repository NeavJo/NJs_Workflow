import { DBG } from '../core/debug.js'
import { updateProgress } from '../ui.js'
import { I18N, t } from '../locales.js'
import { escapeHtml } from '../utils/dom-utils.js'
import { getWorkflows } from './workflow-store.js'
import { getCompletedIds } from './completion-store.js'
import { evaluateTaskRuntime, isTaskTrackable, getTrackableTasks, checkPrerequisites } from './workflow-runtime.js'
import { refreshWorkflowCarousel } from './workflow-carousel.js'
import { getSnoozedIds } from './snooze-store.js'

/**
 * 工作流渲染层：只读 stores，产出 DOM；不写状态、不绑定事件。
 * 事件绑定交给 workflow-events.js，状态写入交给各 store。
 */

// 背景图标池（Material Symbols）
const BG_ICON_POOL = ['task_alt', 'menu_book', 'translate', 'headphones', 'edit_note', 'auto_awesome', 'schedule', 'event_available', 'school', 'psychology']
// 会话内缓存：item.id -> iconName
const BG_ICON_CACHE = new Map()
let lastUsedIcon = null

// URL 协议白名单：阻断 javascript:/data:/vbscript: 等可执行协议注入
function safeHref(raw) {
  const url = String(raw || '').trim()
  if (!url) return null
  const lower = url.toLowerCase()
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('//')) return url
  return null
}

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
  if (!tagInfo?.label) return ''
  const variantClass = tagInfo.variant === 'muted' ? 'dynamic-tag--muted' : 'dynamic-tag--accent'
  const iconHtml = tagInfo.icon ? `<span class="material-symbols dynamic-tag__icon" aria-hidden="true">${tagInfo.icon}</span>` : ''
  return `<div class="dynamic-tag ${variantClass}">${iconHtml}<span class="dynamic-tag__label"></span></div>`
}

// 判断卡片是否应归入「禁用组」（占位 / 运行时禁用如休息日 / 今日搁置）。
// 用于「可操作优先」排序：禁用组整体排到末尾，组内仍按原始工作流序号。
// 已完成但可操作、前置未解锁但可等待的任务不算禁用，保留在正常组。
function isWorkflowCardDisabled(rawItem, snoozedIds) {
  if (rawItem.isPlaceholder) return true
  const { disabled } = evaluateTaskRuntime(rawItem)
  if (disabled) return true
  return Boolean(snoozedIds && snoozedIds.has(rawItem.id))
}

function hydrateDynamicTag(root, tagInfo) {
  if (!tagInfo) return false
  const label = root.querySelector('.dynamic-tag__label')
  if (label) label.textContent = tagInfo.label
  return true
}

function createCard(rawItem, order, completedIds, workflows, snoozedIds, orderMap) {
  const card = document.createElement('article')
  card.id = `workflow-card-${rawItem.id}`
  card.dataset.itemId = rawItem.id
  // 记录原始工作流序号，供移动端「可操作优先」重排按此稳定归位；不随展示顺序变化。
  card.dataset.order = String(order)
  const isComplete = completedIds.has(rawItem.id)
  const isSnoozed = Boolean(snoozedIds && snoozedIds.has(rawItem.id))
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
        <input type="checkbox" disabled aria-label="${escapeHtml(rawItem.title)}" />
        <span class="checkbox-mark"><span class="material-symbols" aria-hidden="true">lock</span></span>
      </label>`
    card.querySelector('.order-badge').textContent = String(order).padStart(2, '0')
    card.querySelector('.workflow-card__title').textContent = rawItem.title
    card.querySelector('.workflow-card__description').textContent = rawItem.desc || ''
    return card
  }

  const cardClasses = ['workflow-card']
  if (disabled) cardClasses.push('is-disabled')
  if (isSnoozed) cardClasses.push('is-snoozed')
  if (isComplete && !disabled) cardClasses.push('is-complete')
  const { ready: prereqReady, missingIds } = checkPrerequisites(rawItem)
  const prereqLocked = !prereqReady && missingIds.length > 0
  if (prereqLocked) cardClasses.push('is-prereq-locked')
  card.className = cardClasses.join(' ')

  const checkEnabled = Boolean(rawItem.checkConfig?.enabled)
  const effectiveDesc = (rawItem.desc && rawItem.desc.trim())
    ? rawItem.desc
    : (checkEnabled
        ? t(I18N.workflow.descFallback, { category: rawItem.checkConfig.category || I18N.workflow.defaultCategory, count: rawItem.checkConfig.targetCount })
        : rawItem.desc)

  // 搁置任务与其它锁定态一样禁用 checkbox；搁置优先级最高，已搁置任务不允许完成。
  const checkboxLocked = disabled || checkEnabled || prereqLocked || isSnoozed
  const checkboxAttrs = checkboxLocked
    ? `disabled aria-label="${escapeHtml(rawItem.title)}" ${isComplete ? 'checked' : ''}`
    : `data-item-id="${escapeHtml(rawItem.id)}" ${isComplete ? 'checked' : ''} aria-label="${escapeHtml(rawItem.title)}"`

  let checkIcon = ''
  if (isComplete) {
    checkIcon = 'check'
  } else if (isSnoozed) {
    checkIcon = 'pause'
  } else if (disabled) {
    checkIcon = tagInfo?.icon || 'lock'
  } else {
    checkIcon = ''
  }
  if (checkEnabled) cardClasses.push('has-check-lock')
  card.className = cardClasses.join(' ')

  const safeUrl = safeHref(rawItem.url)
  const jumpButtonHtml = safeUrl
    ? `<a class="workflow-card__action" href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener noreferrer" aria-label="跳转：${escapeHtml(rawItem.title)}"><span class="material-symbols" aria-hidden="true">open_in_new</span></a>`
    : ''
  const checkButtonHtml = checkEnabled && !disabled && !prereqLocked && !isSnoozed
    ? `<button class="workflow-card__check-btn" type="button" data-check-action="memo-count" data-item-id="${escapeHtml(rawItem.id)}" aria-label="检查并打卡：${escapeHtml(rawItem.title)}"><span class="material-symbols" aria-hidden="true">fact_check</span><span class="workflow-card__check-btn__label">检查</span></button>`
    : ''
  const actionAreaHtml = jumpButtonHtml || checkButtonHtml
    ? `<div class="workflow-card__action-area">${jumpButtonHtml}${checkButtonHtml}</div>`
    : ''

  // 搁置状态徽章：在标题行显示，明确告知用户该任务今日已被临时搁置。
  const snoozeBadgeHtml = isSnoozed
    ? `<span class="snooze-badge" aria-label="今日已搁置">${I18N.workflow.snoozedBadge}</span>`
    : ''

  // 前置任务 Badge
  const prereqBadgeHtml = Array.isArray(rawItem.prerequisites) && rawItem.prerequisites.length > 0
    ? (() => {
        const locked = prereqLocked
        const otherTasks = workflows.filter((t) => rawItem.prerequisites.includes(t.id))
        // 移动端列表会重排展示顺序，但前置徽章必须沿用原始工作流序号，
        // 与卡片序号徽章保持一致，避免误导“第几项”。
        const nums = otherTasks.map((t) => {
          const num = orderMap ? orderMap.get(t.id) : workflows.indexOf(t) + 1
          return `#${String(num).padStart(2, '0')}`
        }).join(' ')
        const label = locked
          ? t(I18N.workflow.prerequisiteBadgeLocked, { list: nums })
          : t(I18N.workflow.prerequisiteBadgeUnlocked, { list: nums })
        return `<span class="prereq-badge ${locked ? 'prereq-badge--locked' : 'prereq-badge--ready'}" aria-label="前置任务：${label}">🔗 ${label}</span>`
      })()
    : ''

  const tagBlockHtml = buildDynamicTagHtml(tagInfo)
  const descriptionHtml = effectiveDesc ? `<p class="workflow-card__description"></p>` : ''

  card.innerHTML = `
    ${buildBgIconHtml(rawItem.id)}
    <div class="order-badge" aria-hidden="true"></div>
    <div class="workflow-card__content">
      <div class="workflow-card__title-row">
        <h3 class="workflow-card__title"></h3>
        ${snoozeBadgeHtml ? `<span class="workflow-card__snooze-indicator">${snoozeBadgeHtml}</span>` : ''}
        ${prereqBadgeHtml ? `<span class="workflow-card__prereq-indicator">${prereqBadgeHtml}</span>` : ''}
      </div>
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
  const originalWorkflows = getWorkflows()
  const completedIds = getCompletedIds()
  const trackableTasks = getTrackableTasks()
  const snoozedIds = getSnoozedIds()

  // 所有布局（含桌面端）都按「可操作优先」排序：正常态卡片按原始序号在前，
  // 禁用态（占位 / 休息日 / 搁置）按原始序号在后。卡片序号徽章始终使用原始
  // 工作流序号（orderById），不随展示顺序变化；分组依据卡片禁用判定，与
  // carousel 侧 reorderCardsForMobile 的状态类判定一致，幂等收敛。
  const orderById = new Map(originalWorkflows.map((item, index) => [item.id, index + 1]))
  const displayWorkflows = originalWorkflows
    .map((rawItem, index) => ({ rawItem, index }))
    .sort((a, b) => {
      const aDisabled = isWorkflowCardDisabled(a.rawItem, snoozedIds)
      const bDisabled = isWorkflowCardDisabled(b.rawItem, snoozedIds)
      if (aDisabled !== bDisabled) return aDisabled ? 1 : -1
      return a.index - b.index
    })
    .map((entry) => entry.rawItem)

  list.replaceChildren(...displayWorkflows.map((item) => createCard(item, orderById.get(item.id), completedIds, displayWorkflows, snoozedIds, orderById)))
  // 今日进度：分母排除今日已搁置任务，分子只统计真实完成的可跟踪任务。
  // 搁置不属于完成，已完成任务也不会出现在搁置集合中，二者互斥。
  const completed = trackableTasks.filter((t) => completedIds.has(t.id)).length
  const total = trackableTasks.filter((t) => !snoozedIds.has(t.id)).length
  const progressCompleted = total === 0 && trackableTasks.length > 0
    ? 1
    : completed
  const progressTotal = total === 0 && trackableTasks.length > 0 ? 1 : total
  DBG('render:workflow', { completed: progressCompleted, total: progressTotal, snoozed: snoozedIds.size })
  updateProgress(progressCompleted, progressTotal)
  refreshWorkflowCarousel()
}

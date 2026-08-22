import { DBG } from '../core/debug.js'

/**
 * 移动端工作流卡轮播控制模块。
 *
 *  - 仅在窄屏（<=680px）激活，桌面布局下保持不变。
 *  - 状态以「active item id」保存，避免重渲染后索引漂移。
 *  - scroll 事件 rAF 节律：通过 bounding rect 中心点对比找出「最可见」的卡片。
 *  - 分页小圆点是真正的 <button>，支持键盘 / 屏幕阅读器。
 *  - 暴露 refreshWorkflowCarousel()，由 renderWorkflow() 在每次重渲染后调用。
 */

const MOBILE_QUERY = '(max-width: 680px)'
const mobileMq = typeof window !== 'undefined' ? window.matchMedia(MOBILE_QUERY) : null

let activeItemId = null
let listenersBound = false

function getList() {
  return document.querySelector('#workflow-list')
}

function getStatusEl() {
  return document.querySelector('#workflow-carousel-status')
}

function getPaginationEl() {
  return document.querySelector('#workflow-carousel-pagination')
}

function getCards() {
  const list = getList()
  if (!list) return []
  return Array.from(list.querySelectorAll('.workflow-card[data-item-id]'))
}

function isMobileCarouselMode() {
  return Boolean(mobileMq && mobileMq.matches)
}

/** 在卡片列表中按 id 找下标；找不到时返回 -1。 */
function getCardIndexById(cards, itemId) {
  if (!itemId) return -1
  return cards.findIndex((card) => card.dataset.itemId === itemId)
}

/** 挑选默认聚焦卡：第一个「未完成且未禁用」的卡片；都没有就退回第一张。 */
function getFallbackCard(cards) {
  for (const card of cards) {
    if (card.classList.contains('is-complete')) continue
    if (card.classList.contains('is-disabled')) continue
    return card
  }
  return cards[0] || null
}

/** 计算「最靠近视口中心」的卡片。 */
function findMostVisibleCard(cards, list) {
  if (!cards.length || !list) return null
  const listRect = list.getBoundingClientRect()
  const center = listRect.left + listRect.width / 2
  let best = null
  let bestDistance = Infinity
  for (const card of cards) {
    const rect = card.getBoundingClientRect()
    if (rect.width === 0) continue
    const cardCenter = rect.left + rect.width / 2
    const distance = Math.abs(cardCenter - center)
    if (distance < bestDistance) {
      bestDistance = distance
      best = card
    }
  }
  return best
}

function setActiveCard(card, { scroll = false, behavior = 'smooth' } = {}) {
  if (!card) return
  const cards = getCards()
  const nextId = card.dataset.itemId || null
  const changed = nextId !== activeItemId
  activeItemId = nextId

  for (const node of cards) {
    node.classList.toggle('is-carousel-active', node === card)
  }

  if (scroll && typeof card.scrollIntoView === 'function') {
    card.scrollIntoView({
      behavior,
      inline: 'center',
      block: 'nearest',
    })
  }

  if (changed) {
    renderCarouselStatus()
    syncPaginationActive()
    DBG('carousel:active', { id: activeItemId, total: cards.length })
  }
}

/** 渲染右上角「X / Y」状态。 */
function renderCarouselStatus() {
  const statusEl = getStatusEl()
  const cards = getCards()
  if (!statusEl) return
  if (!cards.length) {
    statusEl.textContent = '0 / 0'
    return
  }
  const index = getCardIndexById(cards, activeItemId)
  const safeIndex = index >= 0 ? index + 1 : 1
  statusEl.textContent = `${safeIndex} / ${cards.length}`
}

/** 重建分页小圆点。 */
function renderCarouselPagination() {
  const paginationEl = getPaginationEl()
  if (!paginationEl) return
  const cards = getCards()
  paginationEl.replaceChildren()
  if (!isMobileCarouselMode() || cards.length <= 1) {
    paginationEl.hidden = true
    return
  }
  paginationEl.hidden = false

  const fragment = document.createDocumentFragment()
  cards.forEach((card) => {
    const dot = document.createElement('button')
    dot.type = 'button'
    dot.className = 'workflow-carousel-pagination__dot'
    dot.dataset.itemId = card.dataset.itemId || ''
    const title = card.querySelector('.workflow-card__title')?.textContent?.trim() || dot.dataset.itemId
    dot.setAttribute('aria-label', `跳转到：${title}`)
    dot.setAttribute('role', 'tab')
    dot.setAttribute('aria-selected', 'false')
    dot.addEventListener('click', () => {
      setActiveCard(card, { scroll: true })
    })
    fragment.appendChild(dot)
  })
  paginationEl.appendChild(fragment)
  syncPaginationActive()
}

function syncPaginationActive() {
  const paginationEl = getPaginationEl()
  if (!paginationEl) return
  const dots = paginationEl.querySelectorAll('.workflow-carousel-pagination__dot')
  dots.forEach((dot) => {
    const isActive = dot.dataset.itemId === activeItemId
    dot.classList.toggle('is-active', isActive)
    dot.setAttribute('aria-selected', isActive ? 'true' : 'false')
  })
}

/** 重渲染后尝试把滚动条恢复到 activeItemId 对应的卡片；找不到再 fallback。 */
function restoreCarouselPosition() {
  const list = getList()
  if (!list) return
  const cards = getCards()
  if (!cards.length) {
    activeItemId = null
    renderCarouselStatus()
    return
  }
  let target = null
  if (activeItemId) {
    target = cards.find((card) => card.dataset.itemId === activeItemId) || null
  }
  if (!target) {
    target = getFallbackCard(cards)
    activeItemId = target?.dataset?.itemId || null
  }
  if (target) {
    // 用 requestAnimationFrame 等 layout 稳定后立即跳转，不带平滑动画，避免与重渲染闪烁。
    requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: 'auto', inline: 'center', block: 'nearest' })
      setActiveCard(target, { scroll: false })
    })
  }
  renderCarouselStatus()
}

let scrollRaf = 0
function handleCarouselScroll() {
  if (!isMobileCarouselMode()) return
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    const list = getList()
    const cards = getCards()
    const best = findMostVisibleCard(cards, list)
    if (best) setActiveCard(best, { scroll: false })
  })
}

/**
 * 移动端把鼠标滚轮（竖向 deltaY + 触控板横向 deltaX）映射到 #workflow-list 的
 * scrollLeft，让任意带滚轮的指针设备都能像触摸滑动一样左右翻卡片。
 *
 *  - 仅在 carousel 模式下生效，桌面布局保持原状。
 *  - 用 preventDefault 屏蔽默认竖向滚动，避免"想翻卡片结果整页抖"。
 *  - 用 rAF 合批多次 wheel 事件，手感平滑且与原生滚动一致。
 *  - 加速度系数 1.0，scroll-snap 会把卡片自动吸附到 center，无需额外插值。
 */
let wheelTarget = null

function handleCarouselWheel(event) {
  const list = event.currentTarget || getList()
  if (!list) return
  if (list.scrollWidth <= list.clientWidth + 1) return

  // 仅消费"主要竖直 / 水平"滚轮：deltaMode 0/1/2 都会被浏览器归一化到 px。
  const dx = event.deltaX
  const dy = event.deltaY
  if (dy === 0 && dx === 0) return

  // 用户当前的水平滚动意图明显（横向触摸板），按原值横向；
  // 否则把竖向滚轮转换为横向滚动。
  const dominant = Math.abs(dx) > Math.abs(dy)
  const scrollAmount = dominant ? dx : dy

  // 边界判断：到最左/最右时仍允许继续滚动整页，避免页面被卡死。
  const currentTarget = wheelTarget === null ? list.scrollLeft : wheelTarget
  const maxScroll = list.scrollWidth - list.clientWidth
  const atStart = currentTarget <= 0
  const atEnd = currentTarget >= maxScroll
  const tryingToScrollBeyond = (atStart && scrollAmount < 0) || (atEnd && scrollAmount > 0)
  if (tryingToScrollBeyond) return

  event.preventDefault()
  wheelTarget = Math.max(0, Math.min(maxScroll, currentTarget + scrollAmount))
  list.scrollTo({ left: wheelTarget, behavior: 'smooth' })
}

function handleCarouselKeydown(event) {
  if (!isMobileCarouselMode()) return
  const cards = getCards()
  if (!cards.length) return
  const currentIndex = getCardIndexById(cards, activeItemId)
  let nextIndex = currentIndex
  switch (event.key) {
    case 'ArrowLeft':
      nextIndex = Math.max(0, currentIndex - 1)
      break
    case 'ArrowRight':
      nextIndex = Math.min(cards.length - 1, currentIndex + 1)
      break
    case 'Home':
      nextIndex = 0
      break
    case 'End':
      nextIndex = cards.length - 1
      break
    default:
      return
  }
  if (nextIndex === currentIndex || nextIndex < 0) return
  event.preventDefault()
  setActiveCard(cards[nextIndex], { scroll: true })
}

function handleMqChange() {
  if (!isMobileCarouselMode()) {
    // 回到桌面模式：清理激活态、隐藏分页点
    activeItemId = null
    const cards = getCards()
    cards.forEach((card) => card.classList.remove('is-carousel-active'))
    const paginationEl = getPaginationEl()
    if (paginationEl) paginationEl.hidden = true
    return
  }
  refreshWorkflowCarousel()
}

function bindCarouselEvents() {
  if (listenersBound) return
  const list = getList()
  if (!list) return
  list.addEventListener('scroll', handleCarouselScroll, { passive: true })
  list.addEventListener('keydown', handleCarouselKeydown)
  list.addEventListener('wheel', handleCarouselWheel, { passive: false })
  if (mobileMq && typeof mobileMq.addEventListener === 'function') {
    mobileMq.addEventListener('change', handleMqChange)
  } else if (mobileMq && typeof mobileMq.addListener === 'function') {
    mobileMq.addListener(handleMqChange)
  }
  listenersBound = true
}

/**
 * renderWorkflow() 在替换卡片列表后调用：
 *  - 桌面模式：仅做一次激活态清理，避免历史脏数据。
 *  - 移动模式：重建分页点、恢复滚动、刷新状态。
 */
export function refreshWorkflowCarousel() {
  const list = getList()
  if (!list) return

  bindCarouselEvents()

  if (!isMobileCarouselMode()) {
    activeItemId = null
    const cards = getCards()
    cards.forEach((card) => card.classList.remove('is-carousel-active'))
    const paginationEl = getPaginationEl()
    if (paginationEl) paginationEl.hidden = true
    return
  }

  list.classList.add('workflow-list--carousel')
  renderCarouselPagination()
  restoreCarouselPosition()
}

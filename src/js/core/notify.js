/**
 * 统一通知模块（notify）· 全项目唯一的提示出口
 * -----------------------------------------------------------------------------
 * 五类提示：success（成功）/ fail（失败）/ warn（警告）/ info（普通）/ loading（进行中）
 *
 * 对外：
 *   import { notify } from './core/notify.js'
 *   notify.success('已保存')
 *   notify.fail('保存失败，请重试', { event: 'memo.save' })
 *   notify.warn('API Key 是明文，建议设置口令')
 *   notify.info('正在上传…', { event: 'gist.upload' })
 *   notify.loading('正在处理…', { event: 'anki.batch' })
 *   notify.update('anki.batch', { level: 'success', message: '已处理 8 条' })  // 原地更新
 *   notify.dismiss(id) / notify.dismissAll()
 *
 * 兼容：ui.js 的 showToast(message, { status }) 转发到这里，老调用方无需改动。
 *
 * 行为约定（改动前请先读这段）：
 * 1. 位置：桌面右下角；手机贴底，并让出底部安全区与「当前打开的全屏 Modal 底部操作栏」
 *    的真实高度（运行时测量，见 syncBottomOffset）。不做随键盘"上移避让"。
 * 2. 动画：桌面从右侧滑入、滑回右侧；手机从下方滑入、向下滑出。起止点都在视口外，
 *    入场带极小微回弹（桌面约 4px、移动约 2px），退场不回弹、只加速离开。
 *    减少动态效果（prefers-reduced-motion）时去掉位移与缩放，只保留 120ms 淡入淡出。
 *    动画时长常量必须与 toast.css 的 --toast-in-dur / --toast-out-dur 等变量一致。
 * 3. 时长按文字长度自适应：短句约 2.5s，每多 10 字 +0.6s，普通/成功最多 5s；
 *    失败固定 8s 后自动消失，期间可手动关闭；鼠标悬停或手指按住时暂停计时。
 *    停留计时从「入场动画结束」开始，动画本身不占用停留时间。
 * 4. 同屏条数分端处理（断点与 toast.css 一致：680px）：
 *    桌面最多 3 条，超出折叠成"还有 N 条"，失败排在最前；
 *    移动端只显示 1 条，新提示与旧提示同槽接力：旧条 120ms 下滑淡出、
 *    新条延迟 60ms 入场（合计不超过 200ms），不排队等待。
 * 4.1 移动端单条固定单行、超宽省略号截断；点击被截断的提示展开全文
 *     （可折行，仍只此一条），再次点击收起；展开阅读期间暂停计时。
 * 5. 去重按"业务事件名"（options.event），不是按文案；没传 event 时退化为按文案。
 *    同类失败在时间窗内合并计数，显示"保存失败（3 次）"。
 * 6. 进行中（loading）原地更新，不新增条目；更新为成功/失败后按新等级重新计时。
 * 7. 容器本身不拦截页面点击与滚动，只有提示本体（含关闭按钮）可交互。
 * 8. 退场统一入口：关闭按钮、自动消失、外部 dismiss 走同一条淡出路径；
 *    去重替换、断点清理等"换内容"场景不播退场动画，直接移除。
 */

import { I18N, t } from '../locales.js'

const DESKTOP_MAX_VISIBLE = 3
const MOBILE_MAX_VISIBLE = 1
const FAIL_MS = 8000
const WARN_MIN_MS = 6000
const WARN_MAX_MS = 8000
const AUTO_MAX_MS = 5000
const AUTO_MIN_MS = 2500
const BASE_MS = 2000
const PER_CHAR_STEP = 10
const PER_CHAR_MS = 600

/* ---------------------------------------------------------------------------
 * 动画时长（毫秒）
 * 与 toast.css 中的 --toast-in-dur / --toast-out-dur / --toast-fade-* 必须同步；
 * 修改任一处都要同步另一处，否则计时起点或节点移除时机会和视觉对不上。
 * ------------------------------------------------------------------------- */
const ENTER_MS_DESKTOP = 240
const ENTER_MS_MOBILE = 260
const ENTER_MS_QUICK = 120
const EXIT_MS_DESKTOP = 180
const EXIT_MS_MOBILE = 200
const EXIT_MS_QUICK = 120
const REDUCED_MS = 120
/** 移动端同槽替换：新条延迟 60ms 接力，配合 120ms 入场，总时长控制在 200ms 内 */
const REPLACE_DELAY_MS = 60
/** 桌面多条堆叠时的位置过渡（FLIP） */
const FLIP_MS = 220
/** 移动端展开/收起的高度过渡 */
const EXPAND_MS = 220
/** 最后一条退场结束后，容器再隐藏的缓冲（等待退场节点真正移除） */
const HIDE_DELAY_MS = 280

/** 同级同事件的去重窗口；loading 不做去重（它靠原地更新） */
const DEDUPE_MS = { success: 1500, info: 1500, fail: 5000, warn: 4000, loading: 0 }

/** 排序优先级：数值越小越靠前显示 */
const LEVEL_ORDER = { fail: 0, warn: 1, info: 2, success: 3, loading: 4 }

const ICONS = {
  success: 'check_circle',
  fail: 'error',
  warn: 'warning',
  info: 'info',
  loading: 'hourglass_top'
}

/** 旧 status 到新等级的映射；未命中（含 default / undefined）走文案推断 */
const STATUS_TO_LEVEL = {
  success: 'success',
  error: 'fail',
  fail: 'fail',
  warning: 'warn',
  warn: 'warn',
  info: 'info',
  loading: 'loading'
}

/* ---------------------------------------------------------------------------
 * 文案推断（兼容 147 处未显式指定颜色的旧调用）
 * 规则与用户约定一致：
 *   - 含"失败 / 错误 / 无法 / 不能"→ 失败
 *   - 含"已 / 成功 / 完成"      → 成功
 *   - 其余                      → 中性
 * 注意：先判失败再判成功，避免"已失败"这类文案被误判为成功。
 * 想推翻此规则时，只需改这两个正则，或让调用方显式传 status/level。
 * ------------------------------------------------------------------------- */
const FAIL_HINTS = /失败|错误|无法|不能|异常|超时|未找到/
const SUCCESS_HINTS = /成功|完成|已/

function inferLevel(text) {
  if (FAIL_HINTS.test(text)) return 'fail'
  if (SUCCESS_HINTS.test(text)) return 'success'
  return 'info'
}

function resolveLevel(status, text) {
  if (typeof status === 'string' && STATUS_TO_LEVEL[status]) return STATUS_TO_LEVEL[status]
  return inferLevel(text)
}

/* ---------------------------------------------------------------------------
 * 内部状态
 * ------------------------------------------------------------------------- */
let seq = 0
/** @type {Array<Object>} 所有活跃条目（含超出同屏上限而排队暂不上屏的） */
const items = []
let boxEl = null
let moreEl = null
let hideTimer = null

/* ---------------------------------------------------------------------------
 * 布局与动效偏好感知
 * 断点必须与 toast.css 的媒体查询保持一致（680px），改动时两处同步。
 * ------------------------------------------------------------------------- */
const mqMobile =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(max-width: 680px)')
    : { matches: false }

const mqReduced =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false }

function isMobileLayout() {
  return mqMobile.matches
}

function maxVisible() {
  return isMobileLayout() ? MOBILE_MAX_VISIBLE : DESKTOP_MAX_VISIBLE
}

function enterDuration(item) {
  if (mqReduced.matches) return REDUCED_MS
  if (item && item.entryDuration) return item.entryDuration
  return isMobileLayout() ? ENTER_MS_MOBILE : ENTER_MS_DESKTOP
}

function exitDuration(item) {
  if (mqReduced.matches) return REDUCED_MS
  if (item && item.exitDuration) return item.exitDuration
  return isMobileLayout() ? EXIT_MS_MOBILE : EXIT_MS_DESKTOP
}

/**
 * 移动端底部让位：安全区交给 CSS env()；如果当前有打开的全屏 Modal，
 * 再把提示抬到它的底部操作栏之上。
 *
 * 只有一个事实来源：容器的 bottom 与条目的退场位移都引用
 * --toast-bottom-offset，所以"退场终点"永远等于"完全离开屏幕"。
 * 不做 88px 之类的固定兜底，避免操作栏高度变化后留一截。
 */
function syncBottomOffset(box) {
  if (!box) return
  if (!isMobileLayout()) {
    box.style.removeProperty('--toast-bottom-offset')
    return
  }
  let offset = 0
  try {
    const bar = document.querySelector('.modal.is-open .modal__footer')
    if (bar) {
      const rect = bar.getBoundingClientRect()
      const fromBottom = window.innerHeight - rect.top
      // 操作栏自身已包含安全区内边距，这里直接量到视口底部的距离
      if (rect.height > 0 && fromBottom > 0) offset = fromBottom + 12
    }
  } catch (e) {
    console.error('[notify] 计算底部操作栏高度失败', e)
  }
  if (offset > 0) {
    box.style.setProperty('--toast-bottom-offset', `${Math.round(offset)}px`)
  } else {
    box.style.removeProperty('--toast-bottom-offset')
  }
}

// 断点切换（手机旋转 / 桌面窗口拖窄）时：收起已展开的条目，并按新布局重排。
// 切到移动端时只保留当前最优先的一条，其余立即移除（不走退场动画），
// 避免残留排队条目在之后陆续冒出，违背"移动端只显示一条"的规则。
if (typeof mqMobile.addEventListener === 'function') {
  mqMobile.addEventListener('change', () => {
    if (isMobileLayout()) {
      const keep = visibleItems()[0]
      for (const item of [...items]) {
        if (item !== keep) dropItem(item, { animate: false })
      }
    }
    for (const item of items) collapseExpanded(item)
    render()
  })
}

/** 与旧实现一致：敏感信息打码 + 硬截断，防止把 token 或超长文本甩到界面上 */
function sanitize(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/ghp_[A-Za-z0-9]+/g, 'ghp_***')
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_***')
    .replace(/[a-f0-9]{20,}/g, (m) => (m.length > 24 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m))
    .slice(0, 240)
}

function getContainer() {
  if (boxEl && boxEl.isConnected) return boxEl
  boxEl = document.querySelector('#toast')
  if (!boxEl) {
    // index.html 里应有 #toast；万一缺失（测试环境 / 极端时序）就补一个，保证提示不丢
    boxEl = document.createElement('div')
    boxEl.id = 'toast'
    boxEl.className = 'toast'
    boxEl.setAttribute('role', 'status')
    boxEl.setAttribute('aria-live', 'polite')
    boxEl.hidden = true
    document.body.appendChild(boxEl)
  }
  return boxEl
}

function durationFor(level, text, override) {
  if (typeof override === 'number' && override > 0) return override
  if (level === 'loading') return 0
  if (level === 'fail') return FAIL_MS
  const len = String(text || '').length
  const base = BASE_MS + Math.ceil(len / PER_CHAR_STEP) * PER_CHAR_MS
  if (level === 'warn') return Math.min(WARN_MAX_MS, Math.max(WARN_MIN_MS, base))
  return Math.min(AUTO_MAX_MS, Math.max(AUTO_MIN_MS, base))
}

function displayText(item) {
  if (item.count > 1) {
    return t(I18N.toast.system.repeatCount, { message: item.baseText, count: item.count })
  }
  return item.baseText
}

function createNode(item) {
  const node = document.createElement('div')
  // 先进入"准备态"（屏幕外 + 透明），等布局完成后再切到终态触发 transition，
  // 保证首次出现不会先在原地闪一下。
  node.className = `toast__item toast__item--${item.level} is-preparing`
  node.dataset.toastId = String(item.id)

  const icon = document.createElement('span')
  icon.className = 'toast__icon material-symbols'
  icon.setAttribute('aria-hidden', 'true')
  icon.textContent = ICONS[item.level] || ICONS.info

  const text = document.createElement('span')
  text.className = 'toast__text'
  text.textContent = displayText(item)

  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'toast__close'
  close.setAttribute('aria-label', I18N.toast.system.closeToastAria)
  const closeIcon = document.createElement('span')
  closeIcon.className = 'material-symbols'
  closeIcon.setAttribute('aria-hidden', 'true')
  closeIcon.textContent = 'close'
  close.appendChild(closeIcon)
  close.addEventListener('click', (e) => {
    e.stopPropagation()
    dismiss(item.id)
  })

  // 悬停 / 按住暂停计时，离开 / 松开后继续。
  // 只影响倒计时，不影响入场/退场动画本身；入场途中就悬停的，
  // 入场结束后也不会启动计时（startTimer 会检查 hovered / pressed）。
  node.addEventListener('mouseenter', () => {
    item.hovered = true
    pauseTimer(item)
  })
  node.addEventListener('mouseleave', () => {
    item.hovered = false
    startTimer(item)
  })
  node.addEventListener('pointerdown', () => {
    item.pressed = true
    pauseTimer(item)
  })
  node.addEventListener('pointerup', () => {
    item.pressed = false
    startTimer(item)
  })
  node.addEventListener('pointercancel', () => {
    item.pressed = false
    startTimer(item)
  })

  // 移动端：单行被截断时点击展开全文、再次点击收起（见 toggleExpand）。
  // 桌面端文本自然折行不存在截断，点击不做任何事；关闭按钮自行 stopPropagation。
  node.addEventListener('click', (e) => {
    if (e.target.closest('.toast__close')) return
    toggleExpand(item)
  })

  node.appendChild(icon)
  node.appendChild(text)
  if (item.closable) node.appendChild(close)
  return node
}

/**
 * 重建 className 时保留所有动画/展开状态类。
 * 直接赋 className 会丢掉 is-preparing / is-entering，导致入场动画被中断。
 */
function syncNodeClass(item) {
  const node = item.node
  if (!node) return
  const keep = []
  for (const cls of ['is-preparing', 'is-entering', 'is-leaving']) {
    if (node.classList.contains(cls)) keep.push(cls)
  }
  node.className =
    `toast__item toast__item--${item.level}` +
    (item.expanded ? ' is-expanded' : '') +
    (keep.length ? ` ${keep.join(' ')}` : '')
}

function updateNode(item) {
  const node = item.node
  if (!node) return
  syncNodeClass(item)
  const icon = node.querySelector('.toast__icon')
  if (icon) icon.textContent = ICONS[item.level] || ICONS.info
  const text = node.querySelector('.toast__text')
  if (text) text.textContent = displayText(item)
  const close = node.querySelector('.toast__close')
  if (close) close.hidden = !item.closable
  // 文案变化时清掉高度动画的内联值，避免停在旧高度
  if (item.expanded) resetTextHeight(item)
}

/** 判断文本在移动端单行模式下是否被省略号截断 */
function isTextTruncated(item) {
  const textEl = item.node && item.node.querySelector('.toast__text')
  if (!textEl) return false
  return textEl.scrollWidth > textEl.clientWidth
}

/** 清掉展开高度动画留下的内联样式与计时器 */
function resetTextHeight(item) {
  if (item.expandTimer) {
    clearTimeout(item.expandTimer)
    item.expandTimer = null
  }
  const textEl = item.node && item.node.querySelector('.toast__text')
  if (!textEl) return
  textEl.style.transition = ''
  textEl.style.height = ''
  textEl.style.overflow = ''
}

/** 收起展开态（瞬时，用于排队/断点切换）；计时恢复由调用方负责 */
function collapseExpanded(item) {
  if (!item.expanded) return
  resetTextHeight(item)
  item.expanded = false
  if (item.node) item.node.classList.remove('is-expanded')
}

/**
 * 高度过渡的实际执行：先量 from/to，再显式过渡 .toast__text 的 height。
 * 只动文本块的高度，不碰条目自身的 transform 过渡，因此与入场动画互不干扰。
 */
function runHeightTransition(item, textEl, from, to, finalExpanded) {
  const node = item.node
  if (!Number.isFinite(from) || !Number.isFinite(to) || Math.abs(to - from) < 0.5) {
    if (node) node.classList.toggle('is-expanded', finalExpanded)
    return
  }

  textEl.style.transition = 'none'
  textEl.style.overflow = 'hidden'
  textEl.style.height = `${from}px`
  void textEl.offsetHeight

  const done = () => {
    if (item.expandTimer) {
      clearTimeout(item.expandTimer)
      item.expandTimer = null
    }
    textEl.removeEventListener('transitionend', onEnd)
    if (!textEl.isConnected) return
    // 动画结束后才切最终布局态，避免文字在动画开始瞬间跳行
    if (node) node.classList.toggle('is-expanded', finalExpanded)
    textEl.style.transition = ''
    textEl.style.height = ''
    textEl.style.overflow = ''
  }
  const onEnd = (e) => {
    if (e.target !== textEl || e.propertyName !== 'height') return
    done()
  }

  requestAnimationFrame(() => {
    if (!textEl.isConnected) return
    textEl.style.transition = `height ${EXPAND_MS}ms cubic-bezier(0.2, 0, 0, 1)`
    textEl.style.height = `${to}px`
    textEl.addEventListener('transitionend', onEnd)
    item.expandTimer = setTimeout(done, EXPAND_MS + 80)
  })
}

/**
 * 移动端展开/收起全文：
 *  - 只有确实被省略号截断的提示才响应，短文案点击无副作用；
 *  - 展开即暂停计时（阅读期间不消失），收起后从剩余时间继续倒计时；
 *  - 展开不改变"同屏只一条"的排队规则，其余条目继续等待。
 */
function animateTextHeight(item, expanding) {
  const node = item.node
  if (!node) return
  const textEl = node.querySelector('.toast__text')
  if (!textEl) return

  // 清掉上一次未完成的高度动画，避免从中间值起跳
  resetTextHeight(item)
  void textEl.offsetHeight
  const from = textEl.getBoundingClientRect().height

  if (expanding) {
    node.classList.add('is-expanded')
    item.expanded = true
    const to = textEl.getBoundingClientRect().height
    runHeightTransition(item, textEl, from, to, true)
    return
  }

  // 收起：先临时摘掉展开类量出单行高度，再恢复展开态做收缩动画；
  // 动画结束才真正切回单行，避免文字瞬间跳成一行
  node.classList.remove('is-expanded')
  const to = textEl.getBoundingClientRect().height
  node.classList.add('is-expanded')
  item.expanded = false
  runHeightTransition(item, textEl, from, to, false)
}

function toggleExpand(item) {
  if (!isMobileLayout() || item.closed) return
  if (item.expanded) {
    animateTextHeight(item, false)
    startTimer(item)
    return
  }
  if (!isTextTruncated(item)) return
  pauseTimer(item)
  animateTextHeight(item, true)
}

function startTimer(item) {
  if (!item || !item.autoHide || item.closed) return
  // 入场动画未结束不计时：动画时长不算进停留时间
  if (!item.entered) return
  // 展开阅读期间暂停计时，收起后再继续
  if (item.expanded) return
  // 悬停 / 按住期间暂停
  if (item.hovered || item.pressed) return
  // 排队中（未上屏）的条目不倒计时：等真正上屏才开始，避免"没看到就消失"
  if (!visibleItems().includes(item)) return
  if (item.timer) return
  if (item.remaining <= 0) return
  item.startedAt = Date.now()
  item.timer = setTimeout(() => {
    item.timer = null
    dismiss(item.id)
  }, Math.max(200, item.remaining))
}

function pauseTimer(item) {
  if (!item || item.timer == null) return
  clearTimeout(item.timer)
  item.timer = null
  item.remaining = Math.max(0, item.remaining - (Date.now() - item.startedAt))
}

function clearItemTimers(item) {
  if (item.timer) {
    clearTimeout(item.timer)
    item.timer = null
  }
  if (item.entryTimer) {
    clearTimeout(item.entryTimer)
    item.entryTimer = null
  }
  if (item.entryDelayTimer) {
    clearTimeout(item.entryDelayTimer)
    item.entryDelayTimer = null
  }
  if (item.exitTimer) {
    clearTimeout(item.exitTimer)
    item.exitTimer = null
  }
  if (item.expandTimer) {
    clearTimeout(item.expandTimer)
    item.expandTimer = null
  }
}

function visibleItems() {
  return [...items]
    .sort((a, b) => (LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]) || (a.id - b.id))
    .slice(0, maxVisible())
}

function ensureMoreEl(box) {
  if (moreEl && moreEl.isConnected) return moreEl
  moreEl = document.createElement('div')
  moreEl.className = 'toast__more'
  box.appendChild(moreEl)
  return moreEl
}

/**
 * 记录当前可见条目的位置（FLIP 的 First）。
 * 跳过正在入场/退场的节点，它们的 transform 不属于"位置变化"。
 */
function capturePositions(box) {
  const map = new Map()
  if (!box) return map
  const nodes = box.querySelectorAll('.toast__item')
  for (const node of nodes) {
    if (node.hidden) continue
    if (node.style.position === 'fixed') continue
    if (node.classList.contains('is-preparing')) continue
    if (node.classList.contains('is-entering')) continue
    if (node.classList.contains('is-leaving')) continue
    map.set(node, node.getBoundingClientRect().top)
  }
  return map
}

/**
 * 桌面多条堆叠的位置过渡（FLIP）：
 * 只对已有条目做 translateY 补差，不触发布局动画；新条目自己的入场动画不受影响。
 */
function playFlip(box, prev) {
  if (!box || !prev || prev.size === 0) return
  const moved = []
  for (const [node, top] of prev) {
    if (!node.isConnected || node.hidden) continue
    if (node.classList.contains('is-preparing') || node.classList.contains('is-leaving')) continue
    const dy = node.getBoundingClientRect().top - top
    if (Math.abs(dy) < 0.5) continue
    node.style.transition = 'none'
    node.style.transform = `translateY(${dy}px)`
    moved.push(node)
  }
  if (moved.length === 0) return

  void box.offsetHeight
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      for (const node of moved) {
        if (!node.isConnected) continue
        node.style.transition = `transform ${FLIP_MS}ms cubic-bezier(0.2, 0, 0, 1)`
        node.style.transform = ''
      }
      setTimeout(() => {
        for (const node of moved) {
          if (!node.isConnected) continue
          node.style.transition = ''
          node.style.transform = ''
        }
      }, FLIP_MS + 60)
    })
  })
}

/**
 * 入场：先保持 is-preparing 让浏览器完成一次布局/绘制，再切到终态触发 transition。
 * 双 rAF 是为了确保初始帧已经上屏，避免"首次出现闪一下"。
 * 动画结束后才开始停留计时。
 */
function scheduleEnter(item) {
  if (!item || item.entryStarted) return
  item.entryStarted = true

  const run = () => {
    const node = item.node
    if (!node || item.closed) return
    if (node.hidden) {
      // 等它再次上屏时重新安排
      item.entryStarted = false
      return
    }
    if (item.entryDuration) {
      // 移动端同槽接力：用更短的入场时长
      node.style.setProperty('--toast-in-dur', `${item.entryDuration}ms`)
      node.style.setProperty('--toast-fade-in', `${Math.max(80, item.entryDuration - 20)}ms`)
    }

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!node.isConnected || item.closed) return
        if (!node.classList.contains('is-preparing')) return

        node.classList.remove('is-preparing')
        node.classList.add('is-entering')

        const ms = enterDuration(item)
        let finished = false
        const finish = () => {
          if (finished) return
          finished = true
          if (item.entryTimer) {
            clearTimeout(item.entryTimer)
            item.entryTimer = null
          }
          node.removeEventListener('transitionend', onEnd)
          item.entered = true
          node.classList.remove('is-entering')
          startTimer(item)
        }
        const onEnd = (e) => {
          if (e.target !== node) return
          const expect = mqReduced.matches ? 'opacity' : 'transform'
          if (e.propertyName !== expect) return
          finish()
        }

        node.addEventListener('transitionend', onEnd)
        item.entryTimer = setTimeout(finish, ms + 80)
      })
    })
  }

  if (item.entryDelay > 0) {
    item.entryDelayTimer = setTimeout(run, item.entryDelay)
  } else {
    run()
  }
}

/**
 * 把退场节点固定到当前位置并脱离文档流。
 *
 * 这样它不会继续占用 flex 布局空间，其余条目可以立刻移动（交给 FLIP 平滑）；
 * 用 position: fixed + 视觉矩形定位，保证容器高度塌陷时也不会把节点带偏。
 */
function detachForExit(node) {
  const rect = node.getBoundingClientRect()
  node.style.transition = 'none'
  node.style.position = 'fixed'
  node.style.left = `${rect.left}px`
  node.style.top = `${rect.top}px`
  node.style.width = `${rect.width}px`
  node.style.height = `${rect.height}px`
  node.style.margin = '0'
  node.style.pointerEvents = 'none'
  // 视觉位置已经由 left/top 接管，清掉 transform 避免二次位移
  node.style.transform = 'none'
  void node.offsetWidth
  node.style.transition = ''
  node.style.transform = ''
}

/**
 * 统一退场入口：关闭按钮、自动消失、外部 dismiss 都走这里。
 * 移动端同槽替换时用 120ms 快速退场，通过条目上的自定义时长变量实现。
 */
function beginExit(item, { quick = false } = {}) {
  if (!item || item.closed) return
  item.closed = true
  clearItemTimers(item)

  const node = item.node
  if (!node) return

  // 从未真正上屏（排队中 / 还没开始入场）：不需要退场动画
  if (!node.isConnected || node.classList.contains('is-preparing')) {
    resetTextHeight(item)
    node.remove()
    maybeHideContainer()
    return
  }

  if (quick) {
    item.exitDuration = EXIT_MS_QUICK
    node.style.setProperty('--toast-out-dur', `${EXIT_MS_QUICK}ms`)
    node.style.setProperty('--toast-fade-out', `${EXIT_MS_QUICK - 20}ms`)
  }

  detachForExit(node)
  resetTextHeight(item)
  node.classList.remove('is-entering')
  node.classList.add('is-leaving')

  const ms = exitDuration(item)
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    if (item.exitTimer) {
      clearTimeout(item.exitTimer)
      item.exitTimer = null
    }
    node.removeEventListener('transitionend', onEnd)
    node.remove()
    maybeHideContainer()
  }
  const onEnd = (e) => {
    if (e.target !== node) return
    const expect = mqReduced.matches ? 'opacity' : 'transform'
    if (e.propertyName !== expect) return
    finish()
  }

  node.addEventListener('transitionend', onEnd)
  item.exitTimer = setTimeout(finish, ms + 80)
}

/**
 * 作废并移除一个条目：结清计时、从 items 摘除。
 * animate=true 走统一退场；animate=false 用于去重替换、断点清理等"换内容"场景。
 */
function dropItem(item, { animate = false, quick = false } = {}) {
  const idx = items.indexOf(item)
  if (idx >= 0) items.splice(idx, 1)
  if (animate) {
    beginExit(item, { quick })
    return
  }
  item.closed = true
  clearItemTimers(item)
  resetTextHeight(item)
  if (item.node) item.node.remove()
}

function maybeHideContainer() {
  const box = getContainer()
  if (!box) return
  if (items.length > 0) return
  // 还有退场中的节点（已脱离 items）就先别隐藏，否则最后一段动画会被切断
  if (box.querySelector('.toast__item')) return
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    hideTimer = null
    if (items.length === 0 && !box.querySelector('.toast__item')) box.hidden = true
  }, HIDE_DELAY_MS)
}

/**
 * @param {Map<Element, number>} [prevPositions] 变更前的位置快照（FLIP）
 */
function render(prevPositions) {
  const box = getContainer()
  if (!box) return

  syncBottomOffset(box)

  if (items.length > 0) {
    if (hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
    }
    box.hidden = false
  } else {
    // 空了也不要立刻隐藏，否则最后一条的退场会被直接切断
    maybeHideContainer()
  }

  const before = prevPositions || capturePositions(box)
  const visible = visibleItems()
  const visibleIds = new Set(visible.map((it) => it.id))
  let order = 0

  for (const item of items) {
    if (!item.node) continue
    if (visibleIds.has(item.id)) {
      item.node.hidden = false
      item.node.style.order = String(order++)
      if (!item.node.isConnected) box.appendChild(item.node)
    } else {
      item.node.hidden = true
      // 排队条目不保持展开态：等再次上屏时按收起的单行展示
      collapseExpanded(item)
      pauseTimer(item)
    }
  }

  const hiddenCount = items.length - visible.length
  // 「还有 N 条」仅桌面显示；移动端排队条目静默等待，不额外占一行
  if (hiddenCount > 0 && !isMobileLayout()) {
    const more = ensureMoreEl(box)
    more.textContent = t(I18N.toast.system.moreCount, { count: hiddenCount })
    more.style.order = String(order)
    more.hidden = false
  } else if (moreEl) {
    moreEl.hidden = true
  }

  playFlip(box, before)

  // 新上屏的条目安排入场；已经入场的按剩余时间继续计时
  for (const item of visible) {
    if (!item.entered && !item.entryStarted) scheduleEnter(item)
  }
  for (const item of visible) {
    if (item.entered && item.autoHide && !item.timer && item.remaining > 0) startTimer(item)
  }
}

function dismiss(id) {
  const item = items.find((it) => it.id === id)
  if (!item) return
  const box = getContainer()
  const prev = capturePositions(box)
  dropItem(item, { animate: true })
  render(prev)
}

function dismissAll() {
  const box = getContainer()
  const prev = capturePositions(box)
  for (const item of [...items]) dropItem(item, { animate: true })
  render(prev)
}

function push(level, message, options = {}) {
  const text = sanitize(message)
  if (!text) return null

  const now = Date.now()
  const event =
    typeof options.event === 'string' && options.event
      ? options.event
      : `text:${text}`

  const existing = items.find((it) => it.event === event && !it.closed)

  // 进行中：只做原地更新，绝不新增条目
  if (level === 'loading') {
    if (existing) {
      existing.level = 'loading'
      existing.baseText = text
      existing.count = 1
      existing.autoHide = false
      existing.remaining = 0
      existing.lastAt = now
      if (existing.timer) {
        clearTimeout(existing.timer)
        existing.timer = null
      }
      updateNode(existing)
      render()
      return existing.id
    }
  } else if (existing) {
    const win = DEDUPE_MS[level] || 1500
    if (existing.level === level && now - (existing.lastAt || 0) < win) {
      // 同类失败/警告：合并计数，刷新文字与计时，并重新排序到最前
      if (level === 'fail' || level === 'warn') {
        existing.count += 1
        existing.baseText = text
        existing.lastAt = now
        // 先暂停并结清已消耗的时间，再重置为新时长，避免旧计时器继续用旧截止点
        pauseTimer(existing)
        existing.remaining = durationFor(level, text, options.duration)
        updateNode(existing)
        startTimer(existing)
        render()
        return existing.id
      }
      // 成功/普通：窗口内直接忽略，避免连点刷屏
      return existing.id
    }
    // 超出窗口或等级变化：内容语义相同，属于"替换"而不是"关闭"，不走退场动画
    dropItem(existing, { animate: false })
  }

  const prev = capturePositions(getContainer())
  let quickReplace = false

  // 移动端"同槽接力"：旧条 120ms 下滑淡出，新条延迟 60ms 入场，
  // 合计不超过 200ms。先清掉上一轮尚未退场完的孤儿节点，避免叠两层。
  if (isMobileLayout()) {
    const box = getContainer()
    box.querySelectorAll('.toast__item.is-leaving').forEach((node) => {
      if (!items.some((it) => it.node === node)) node.remove()
    })
    const others = [...items]
    quickReplace = others.length > 0
    for (const other of others) dropItem(other, { animate: true, quick: true })
  }

  const item = {
    id: ++seq,
    event,
    level,
    baseText: text,
    count: 1,
    closable: options.closable !== false,
    autoHide: level !== 'loading',
    remaining: durationFor(level, text, options.duration),
    startedAt: 0,
    timer: null,
    node: null,
    closed: false,
    expanded: false,
    lastAt: now,
    // 入场动画状态
    entered: false,
    entryStarted: false,
    entryDelay: quickReplace ? REPLACE_DELAY_MS : 0,
    entryDuration: quickReplace ? ENTER_MS_QUICK : 0,
    entryTimer: null,
    entryDelayTimer: null,
    // 退场
    exitTimer: null,
    exitDuration: 0,
    // 交互暂停
    hovered: false,
    pressed: false,
    // 高度动画
    expandTimer: null
  }
  item.node = createNode(item)
  items.push(item)
  render(prev)
  return item.id
}

/** 兼容入口：旧 showToast(message, { status }) 转到这里 */
export function showNotification(message, options = {}) {
  try {
    const level = resolveLevel(options.status || options.level, sanitize(message))
    return push(level, message, options)
  } catch (e) {
    // 提示系统自身绝不向业务代码抛错
    console.error('[notify] 展示提示失败', e)
    return null
  }
}

/**
 * 原地更新某个事件对应的提示（通常用于"进行中 → 成功/失败"）。
 * 找不到对应条目时按新提示创建。
 */
function updateByEvent(event, { level = 'success', message = '', duration } = {}) {
  const item = items.find((it) => it.event === event && !it.closed)
  if (!item) return push(level, message, { event, duration })
  const text = sanitize(message) || item.baseText
  item.level = level
  item.baseText = text
  item.count = 1
  item.autoHide = level !== 'loading'
  pauseTimer(item)
  item.remaining = durationFor(level, text, duration)
  item.lastAt = Date.now()
  updateNode(item)
  render()
  if (item.autoHide) startTimer(item)
  return item.id
}

export const notify = {
  success: (message, options = {}) => showNotification(message, { ...options, level: 'success' }),
  fail: (message, options = {}) => showNotification(message, { ...options, level: 'fail' }),
  warn: (message, options = {}) => showNotification(message, { ...options, level: 'warn' }),
  info: (message, options = {}) => showNotification(message, { ...options, level: 'info' }),
  loading: (message, options = {}) => showNotification(message, { ...options, level: 'loading' }),
  update: updateByEvent,
  dismiss,
  dismissAll
}

export default notify

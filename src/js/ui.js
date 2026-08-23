import { I18N } from './locales.js'

let toastTimer
let toastHideTimer
let toastQueue = []
let toastDedupeMap = new Map()
const TOAST_VISIBLE_MS = 2200
const TOAST_FADE_MS = 240
const TOAST_DEDUPE_MS = 1200
const TOAST_STATUS_CLASS = {
  success: 'toast--success',
  error: 'toast--error',
  info: 'toast--info',
  warning: 'toast--warning'
}

function sanitizeToastText(text) {
  if (typeof text !== 'string') return ''
  return text
    .replace(/ghp_[A-Za-z0-9]+/g, 'ghp_***')
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_***')
    .replace(/[a-f0-9]{20,}/g, (m) => (m.length > 24 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m))
    .slice(0, 240)
}

function renderToastNode() {
  const toast = document.querySelector('#toast')
  if (!toast) return null
  // 首次使用前 Toast 以 hidden 状态存在，显示前移除，确保任何时刻都不会闪现空胶囊
  toast.hidden = false
  let icon = toast.querySelector('.toast__icon')
  let text = toast.querySelector('.toast__text')
  if (!icon || !text) {
    toast.replaceChildren()
    icon = document.createElement('span')
    icon.className = 'toast__icon material-symbols'
    icon.setAttribute('aria-hidden', 'true')
    text = document.createElement('span')
    text.className = 'toast__text'
    toast.appendChild(icon)
    toast.appendChild(text)
  }
  return { toast, icon, text }
}

function applyToastStatus(node, status) {
  if (!node) return
  const { toast } = node
  toast.classList.remove('toast--success', 'toast--error', 'toast--info', 'toast--warning')
  const cls = TOAST_STATUS_CLASS[status]
  if (cls) toast.classList.add(cls)
  const ICON_FOR = {
    success: 'check_circle',
    error: 'error',
    info: 'info',
    warning: 'warning',
    default: 'notifications'
  }
  node.icon.textContent = ICON_FOR[status] || ICON_FOR.default
}

function showNextToast() {
  const node = renderToastNode()
  if (!node) return
  const next = toastQueue.shift()
  if (!next) return
  const { message, status } = next
  node.text.textContent = message
  applyToastStatus(node, status)
  node.toast.classList.remove('is-visible')
  node.toast.offsetWidth
  node.toast.classList.add('is-visible')
  clearTimeout(toastHideTimer)
  toastHideTimer = setTimeout(() => {
    node.toast.classList.remove('is-visible')
    if (toastQueue.length) setTimeout(showNextToast, TOAST_FADE_MS)
    else setTimeout(() => { node.toast.hidden = true }, TOAST_FADE_MS)
  }, TOAST_VISIBLE_MS)
}

export function showToast(message, options = {}) {
  const cleanMessage = sanitizeToastText(message)
  if (!cleanMessage) return
  const status = options.status || 'default'
  const dedupeKey = `${status}::${cleanMessage}`
  const now = Date.now()
  const last = toastDedupeMap.get(dedupeKey) || 0
  if (now - last < TOAST_DEDUPE_MS) return
  toastDedupeMap.set(dedupeKey, now)
  toastQueue.push({ message: cleanMessage, status })
  if (!document.querySelector('#toast.is-visible') && toastQueue.length === 1) {
    showNextToast()
  }
}

export function clearToast() {
  toastQueue.length = 0
  clearTimeout(toastTimer)
  clearTimeout(toastHideTimer)
  const toast = document.querySelector('#toast')
  if (toast) {
    toast.classList.remove('is-visible')
    toast.hidden = true
  }
}

export function updateProgress(completed, total) {
  const percentage = total ? Math.round((completed / total) * 100) : 0
  const bar = document.getElementById('global-progress-bar')
  if (bar) bar.style.width = `${percentage}%`
  const valueEl = document.getElementById('global-progress-value')
  if (valueEl) valueEl.textContent = `${percentage}%`
  const track = document.querySelector('.progress-track')
  if (track) track.setAttribute('aria-valuenow', percentage)
}

/* =====================================================================
 * Gist 上传状态指示器
 *   showGistUploading()  — 上传开始：显示旋转弧
 *   showGistUploaded()   — 上传成功：旋转弧转换为逐渐绘制的勾
 *   hideGistIndicator() — 清理（取消/失败/异常）
 * ===================================================================== */
let gistIndicatorTimer = null
const GIST_SUCCESS_HOLD_MS = 1400
const GIST_CHECK_ANIM_MS = 450

function getGistIndicator() {
  return document.querySelector('#gist-indicator')
}

function clearGistIndicatorTimer() {
  if (gistIndicatorTimer) {
    clearTimeout(gistIndicatorTimer)
    gistIndicatorTimer = null
  }
}

export function showGistUploading() {
  const el = getGistIndicator()
  if (!el) return
  clearGistIndicatorTimer()
  el.dataset.state = 'uploading'
  el.hidden = false
  el.setAttribute('aria-label', I18N.toast.gist.uploading)
}

export function showGistUploaded() {
  const el = getGistIndicator()
  if (!el) return
  clearGistIndicatorTimer()
  const check = el.querySelector('.gist-indicator__check')
  if (check) {
    check.style.animation = 'none'
    check.getBoundingClientRect()
    check.style.animation = ''
  }
  el.dataset.state = 'success'
  el.setAttribute('aria-label', I18N.toast.gist.uploaded)
  gistIndicatorTimer = setTimeout(() => {
    el.dataset.state = 'idle'
    gistIndicatorTimer = setTimeout(() => { el.hidden = true }, 240)
  }, GIST_SUCCESS_HOLD_MS + GIST_CHECK_ANIM_MS)
}

export function hideGistIndicator() {
  const el = getGistIndicator()
  if (!el) return
  clearGistIndicatorTimer()
  el.dataset.state = 'idle'
  el.removeAttribute('aria-label')
  el.hidden = true
}

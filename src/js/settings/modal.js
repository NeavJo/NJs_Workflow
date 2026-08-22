import { DBG } from '../core/debug.js'

/**
 * 通用 Modal 控制器：openModal/closeModal/closeModalAsync/replaceModal/openConfirmDialog
 * 所有 modal 共享同一个 stack，处理嵌套打开。
 */

export const MODAL_IDS = {
  editor: 'editor-modal',
  taskform: 'taskform-modal',
  rotation: 'taskform-rotation-modal',
  'editor-action': 'editor-action-modal',
  confirm: 'confirm-modal',
  'memo-tag-picker': 'memo-tag-picker-modal'
}

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])'
].join(',')

const openModalStack = []
let modalLastFocused = null
let modalBodyScrollY = 0
const pendingResolvers = new Map()

function getModalRoot(name) {
  const id = MODAL_IDS[name]
  return id ? document.getElementById(id) : null
}

function getModalFocusable(root) {
  const dialog = root?.querySelector('.modal__dialog')
  if (!dialog) return []
  return Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter((el) => el.offsetParent !== null || el === document.activeElement)
}

function lockBodyScroll() {
  if (document.body.classList.contains('modal-open')) return
  modalBodyScrollY = window.scrollY || 0
  document.body.style.setProperty('--modal-scroll-y', `${modalBodyScrollY}px`)
  document.body.classList.add('modal-open')
}

function unlockBodyScroll() {
  if (openModalStack.length > 0) return
  const y = modalBodyScrollY
  document.body.classList.remove('modal-open')
  document.body.style.removeProperty('--modal-scroll-y')
  modalBodyScrollY = 0
  if (y) window.scrollTo({ top: y, left: 0, behavior: 'instant' in window ? 'instant' : 'auto' })
}

function trapModalFocus(e) {
  if (e.key !== 'Tab') return
  const top = openModalStack[openModalStack.length - 1]
  if (!top) return
  const root = getModalRoot(top)
  if (!root || root.hidden) return
  const focusable = getModalFocusable(root)
  if (focusable.length === 0) {
    e.preventDefault()
    const dialog = root.querySelector('.modal__dialog')
    if (dialog) dialog.setAttribute('tabindex', '-1')
    dialog?.focus({ preventScroll: true })
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  const active = document.activeElement
  const insideDialog = root.querySelector('.modal__dialog')?.contains(active)
  if (e.shiftKey) {
    if (!insideDialog || active === first) { e.preventDefault(); last.focus({ preventScroll: true }) }
  } else {
    if (!insideDialog || active === last) { e.preventDefault(); first.focus({ preventScroll: true }) }
  }
}

export function openModal(name) {
  const root = getModalRoot(name)
  if (!root) return
  if (openModalStack.length === 0) {
    modalLastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  if (!openModalStack.includes(name)) openModalStack.push(name)

  root.hidden = false
  root.setAttribute('aria-hidden', 'false')
  lockBodyScroll()
  requestAnimationFrame(() => root.classList.add('is-open'))

  const dialog = root.querySelector('.modal__dialog')
  if (dialog) {
    const firstFocusable = dialog.querySelector(FOCUSABLE_SELECTOR)
    if (firstFocusable) {
      setTimeout(() => firstFocusable.focus({ preventScroll: true }), 180)
    } else {
      dialog.setAttribute('tabindex', '-1')
      setTimeout(() => dialog.focus({ preventScroll: true }), 180)
    }
  }
  DBG('modal:open', name)
}

function finalizeClose(name) {
  const root = getModalRoot(name)
  if (!root) return
  root.hidden = true
  root.setAttribute('aria-hidden', 'true')
  root.removeEventListener('transitionend', onTransitionEnd)
  const idx = openModalStack.indexOf(name)
  if (idx >= 0) openModalStack.splice(idx, 1)
  if (openModalStack.length === 0) {
    unlockBodyScroll()
    if (modalLastFocused && document.contains(modalLastFocused)) {
      try { modalLastFocused.focus({ preventScroll: true }) } catch (e) { /* noop */ }
    }
    modalLastFocused = null
  } else {
    const top = openModalStack[openModalStack.length - 1]
    const topRoot = top ? getModalRoot(top) : null
    if (topRoot) {
      const focusable = getModalFocusable(topRoot)
      if (focusable[0]) setTimeout(() => focusable[0].focus({ preventScroll: true }), 60)
    }
  }
  const resolver = pendingResolvers.get(name)
  if (resolver) {
    pendingResolvers.delete(name)
    resolver()
  }
  DBG('modal:close', name)
}

function onTransitionEnd(e) {
  const dialog = e.currentTarget?.querySelector?.('.modal__dialog')
  if (e.target === dialog || e.propertyName === 'opacity') {
    finalizeClose(e.currentTarget.dataset.modalName || '')
  }
}

export function closeModal(name) {
  const root = getModalRoot(name)
  if (!root || root.hidden) {
    const resolver = pendingResolvers.get(name)
    if (resolver) {
      pendingResolvers.delete(name)
      resolver()
    }
    return
  }
  root.dataset.modalName = name
  root.classList.remove('is-open')
  root.addEventListener('transitionend', onTransitionEnd)
  setTimeout(() => finalizeClose(name), 360)
}

export function closeModalAsync(name) {
  const root = getModalRoot(name)
  if (!root || root.hidden) return Promise.resolve()
  return new Promise((resolve) => {
    pendingResolvers.set(name, resolve)
    closeModal(name)
  })
}

export async function replaceModal(fromName, toName, options = {}) {
  if (isModalOpen(fromName)) {
    await closeModalAsync(fromName)
  }
  if (options.opener && options.opener instanceof HTMLElement) {
    modalLastFocused = options.opener
  }
  openModal(toName)
}

export function isModalOpen(name) {
  const root = getModalRoot(name)
  return Boolean(root && !root.hidden)
}

export function getOpenModalStack() {
  return [...openModalStack]
}

let confirmHandler = null

function ensureConfirmDialog() {
  const root = getModalRoot('confirm')
  if (!root) return null
  const okBtn = root.querySelector('#confirm-ok')
  if (okBtn && !okBtn.dataset.bound) {
    okBtn.dataset.bound = '1'
    okBtn.addEventListener('click', () => {
      const fn = confirmHandler
      confirmHandler = null
      closeModal('confirm')
      if (typeof fn === 'function') fn(true)
    })
  }
  const cancelBtn = root.querySelector('#confirm-cancel')
  if (cancelBtn && !cancelBtn.dataset.bound) {
    cancelBtn.dataset.bound = '1'
    cancelBtn.addEventListener('click', () => {
      const fn = confirmHandler
      confirmHandler = null
      closeModal('confirm')
      if (typeof fn === 'function') fn(false)
    })
  }
  return root
}

export function openConfirmDialog({
  title = '确认操作',
  message = '是否继续？',
  confirmText = '确认',
  cancelText = '取消',
  danger = false
} = {}) {
  return new Promise((resolve) => {
    const root = ensureConfirmDialog()
    if (!root) {
      const fallback = window.confirm(message)
      resolve(Boolean(fallback))
      return
    }
    const titleEl = root.querySelector('#confirm-title')
    const messageEl = root.querySelector('#confirm-message')
    const okBtn = root.querySelector('#confirm-ok')
    if (titleEl) titleEl.textContent = title
    if (messageEl) messageEl.textContent = message
    if (okBtn) {
      okBtn.textContent = confirmText
      okBtn.classList.toggle('btn--danger', Boolean(danger))
    }
    const cancelBtn = root.querySelector('#confirm-cancel')
    if (cancelBtn) cancelBtn.textContent = cancelText
    confirmHandler = resolve
    openModal('confirm')
  })
}

export function bindGlobalModalEvents() {
  document.addEventListener('keydown', trapModalFocus)

  document.addEventListener('click', (e) => {
    const scrim = e.target.closest('.modal__scrim')
    if (!scrim) return
    const root = scrim.closest('.modal')
    if (!root) return
    const name = Object.entries(MODAL_IDS).find(([, id]) => id === root.id)?.[0]
    if (name) closeModal(name)
  })

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-close-modal]')
    if (!btn) return
    const explicit = btn.getAttribute('data-close-modal')
    let name = explicit
    if (!name) {
      const root = btn.closest('.modal')
      if (root) {
        const found = Object.entries(MODAL_IDS).find(([, id]) => id === root.id)?.[0]
        name = found || ''
      }
    }
    if (name && MODAL_IDS[name]) closeModal(name)
  })
}

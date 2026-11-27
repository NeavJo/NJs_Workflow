import { I18N } from './locales.js'
import { showNotification, notify } from './core/notify.js'

/**
 * 轻提示（兼容旧签名）
 * -----------------------------------------------------------------------------
 * 旧调用方 `showToast(message, { status })` 无需改动；
 * 实际实现、排队、去重、计时、可关闭等全部在 core/notify.js。
 * 新代码建议直接用 notify.success / fail / warn / info / loading。
 */
export function showToast(message, options = {}) {
  return showNotification(message, options)
}

/** 清空当前所有提示（含排队） */
export function clearToast() {
  notify.dismissAll()
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

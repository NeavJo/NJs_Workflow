import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N, t } from '../locales.js'
import {
  performDailyReset,
  getCompletionHistory,
  getLastResetDate
} from '../workflow/history-store.js'
import { scheduleAutoUpload } from './gist-sync.js'
import { getTodayDateString } from '../core/date.js'

/**
 * 每日重置 UI 渲染 + 手动触发：
 *  - performDailyReset / checkDailyReset / archiveTodayToHistory 等核心逻辑
 *    已在 workflow/history-store.js 实现，这里只负责 UI 文案与手动按钮
 *  - renderDailyResetStatus：显示"上次重置日" + 历史天数
 *  - manualResetToday：用户点击"立即重置"按钮时执行一次
 */

function getResetStatusEl() {
  return document.getElementById('daily-reset-status')
}

function getResetHistoryDaysEl() {
  return document.getElementById('daily-reset-history-days')
}

/**
 * 渲染"上次重置于 … / X 天历史已留存"。
 * 推荐在切换到 backup 子页面时调用一次刷新。
 */
export function renderDailyResetStatus() {
  const el = getResetStatusEl()
  if (!el) return
  const lastReset = getLastResetDate()
  const today = getTodayDateString()
  if (lastReset) {
    el.textContent = t(I18N.toast.reset.resetAt, { date: lastReset, today })
  } else {
    el.textContent = t(I18N.toast.reset.neverReset, { today })
  }
  const daysEl = getResetHistoryDaysEl()
  if (daysEl) {
    const total = Object.keys(getCompletionHistory()).length
    daysEl.textContent = t(I18N.toast.reset.historyDays, { count: total })
  }
}

/**
 * 用户点击"立即重置今日"时调用：
 *  - confirm 二次确认
 *  - 触发 performDailyReset({ silent: false })
 *  - 重新渲染状态行
 *  - 触发自动上传（如果有 Gist 凭证）
 */
export function manualResetToday() {
  if (!confirm(I18N.toast.reset.confirmReset)) return
  performDailyReset()
  renderDailyResetStatus()
  scheduleAutoUpload()
  showToast(I18N.toast.reset.manualResetDone)
  DBG('daily-reset:manual')
}

/**
 * 绑定 / 每日任务重置 / 按钮：
 *  - 立即重置按钮
 *  - 切换到 backup 子页面时刷新状态文案
 */
export function bindDailyResetEvents() {
  const btn = document.getElementById('btn-daily-reset')
  if (btn) btn.addEventListener('click', manualResetToday)

  // 幂等守卫：bindDailyResetEvents 可能被多次调用（见 settings/index.js 与 backup/events.js 的重复绑定），
  // 用 dataset.bound 防止同一 item 累积多个 click 监听器。
  document.querySelectorAll('.view--settings [data-settings-page]').forEach((item) => {
    if (item.dataset.bound === '1') return
    item.dataset.bound = '1'
    item.addEventListener('click', () => {
      if (item.dataset.settingsPage === 'backup') renderDailyResetStatus()
    })
  })
}

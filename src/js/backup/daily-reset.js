import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
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
  if (lastReset) {
    el.textContent = `上次自动重置于 ${lastReset} · 今天 ${getTodayDateString()}`
  } else {
    el.textContent = `尚未执行过自动重置 · 今天 ${getTodayDateString()}`
  }
  const daysEl = getResetHistoryDaysEl()
  if (daysEl) {
    const total = Object.keys(getCompletionHistory()).length
    daysEl.textContent = `${total} 天历史已留存`
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
  if (!confirm('确认要立即清空今日所有已打卡任务？\n\n清空前会自动把当前已完成状态归档到昨日的历史记录里。')) return
  performDailyReset()
  renderDailyResetStatus()
  scheduleAutoUpload()
  showToast('已手动重置今日打卡状态。')
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

  document.querySelectorAll('.view--settings [data-settings-page]').forEach((item) => {
    item.addEventListener('click', () => {
      if (item.dataset.settingsPage === 'backup') renderDailyResetStatus()
    })
  })
}

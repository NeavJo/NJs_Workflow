import { getCompletionHistory } from './history-store.js'
import { getWorkflows, onWorkflowsChange } from './workflow-store.js'
import { onHistoryChange } from './history-store.js'
import { onCompletedChange, getCompletedIds } from './completion-store.js'
import { getTrackableTasks } from './workflow-runtime.js'
import { getTodayDateString } from '../core/date.js'
import { getSnoozeRecord, onSnoozeChange } from './snooze-store.js'
import { I18N } from '../locales.js'
import { openModal, isModalOpen } from '../settings/modal.js'

export class MonthlyView {
  constructor(container) {
    this.container = container
    this.today = getTodayDateString()
    this.gridSize = 30
    this.columns = 5
    this.rows = 6
    this.lockedCell = null
    this._unsubscribeFns = []
    // 文档级监听的具名 handler 与清理闭包，destroy 时统一移除，避免泄漏
    this._docHandlers = []
    this._initSubscriptions()
  }

  _initSubscriptions() {
    this._subscribe(onWorkflowsChange, () => this.refresh())
    this._subscribe(onHistoryChange, () => this.refresh())
    this._subscribe(onCompletedChange, () => this.refresh())
    // 搁置记录变更时刷新月览：今日/历史日期的橙色态与详情需要同步。
    this._subscribe(onSnoozeChange, () => this.refresh())

    // 文档级键盘：Escape 关闭选中方格
    const onKeydown = (e) => {
      if (e.key === 'Escape' && this.lockedCell) {
        this.hideCellInfo(this.lockedCell)
        this.lockedCell = null
      }
    }
    // 文档级点击空白区域收起；弹窗打开期间跳过，避免误收起仍有效的固定格。
    const onDocClick = (e) => {
      if (!this.lockedCell) return
      if (isModalOpen('snoozeDetail')) return
      if (!e.target.closest('.monthly-view__cell')) {
        this.hideCellInfo(this.lockedCell)
        this.lockedCell = null
      }
    }
    document.addEventListener('keydown', onKeydown)
    document.addEventListener('click', onDocClick)
    this._docHandlers.push(() => {
      document.removeEventListener('keydown', onKeydown)
      document.removeEventListener('click', onDocClick)
    })
  }

  _subscribe(fn, callback) {
    const unsubscribe = fn(callback)
    this._unsubscribeFns.push(unsubscribe)
  }

  refresh() {
    this.render()
  }

  destroy() {
    for (const unsub of this._unsubscribeFns) {
      try { unsub() } catch (_) {}
    }
    this._unsubscribeFns = []
    // 移除文档级 keydown / click 监听，避免组件销毁后仍占用全局事件
    for (const off of this._docHandlers) {
      try { off() } catch (_) {}
    }
    this._docHandlers = []
    if (this.container) this.container.innerHTML = ''
  }

  getData() {
    const history = getCompletionHistory()
    const workflows = getWorkflows()
    const todayCompletedIds = getCompletedIds()

    const data = []
    // 从 YYYY-MM-DD 本地分量构造今天，避免 new Date('YYYY-MM-DD') 按 UTC 解析
    // 在 UTC-x 时区产生"差一天"的 off-by-one。
    const [ty, tm, td] = this.today.split('-').map(Number)
    const today = new Date(ty, tm - 1, td)

    for (let i = 0; i < this.gridSize; i++) {
      const date = new Date(today)
      date.setDate(date.getDate() - i)
      const dateStr = this.formatDate(date)

      // 今日使用实时完成状态；历史日期优先读取首次归档时锁定的 totalTasks 快照
      let completedCount
      let dailyTotalTasks
      if (dateStr === this.today) {
        completedCount = [...todayCompletedIds].filter(id =>
          workflows.some(w => w.id === id)
        ).length
        // 今日尚未归档，必须按当前任务/轮换状态实时计算，避免使用昨日残留快照
        dailyTotalTasks = getTrackableTasks(date).length
      } else {
        const dayHistory = history[dateStr]
        completedCount = dayHistory && Array.isArray(dayHistory.completedIds)
          ? dayHistory.completedIds.length
          : 0
        const snapshotTotal = dayHistory?.totalTasks
        // totalTasks: 0 是合法快照，不能用 || 误判为缺失；缺失时按查看日回退
        dailyTotalTasks = typeof snapshotTotal === 'number'
          ? snapshotTotal
          : getTrackableTasks(date).length
      }

      // x>y（完成数超过分母）时完成率超 100% 会误触 isFull 绿色态与满格透明度，
      // 统一兜底钳制到 100%：既保证满格视觉，也避免后续 rate/100 产生 >1 的非法透明度
      const rate = dailyTotalTasks > 0
        ? Math.min(100, Math.round((completedCount / dailyTotalTasks) * 100))
        : 0

      // 搁置记录按日期独立保存，今日与历史日期统一从 snooze store 读取。
      // 历史日期即使任务已被删除/改名，快照名称仍可读。
      const snoozeRecord = getSnoozeRecord(dateStr)
      const hasSnoozed = Boolean(snoozeRecord && Array.isArray(snoozeRecord.taskSnapshots) && snoozeRecord.taskSnapshots.length > 0)
      const snoozeSnapshots = hasSnoozed ? snoozeRecord.taskSnapshots : []
      const snoozeReason = hasSnoozed ? (snoozeRecord.reason || '') : ''

      data.push({
        date: date,
        dateStr: dateStr,
        completed: completedCount,
        total: dailyTotalTasks,
        rate: rate,
        isToday: dateStr === this.today,
        hasSnoozed,
        snoozeSnapshots,
        snoozeReason
      })
    }

    return data
  }

  formatDate(date) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  render() {
    const data = this.getData()
    const stats = this.calculateStats(data)

    this.container.innerHTML = `
      <div class="monthly-view" role="region" aria-label="月览 - 过去30天任务完成情况">
        <div class="monthly-view__grid" role="grid" aria-label="任务完成网格">
          ${data.map(day => this.createCell(day)).join('')}
        </div>
        <div class="monthly-view__stats">
          <span class="monthly-view__stat-item">
            <span class="material-symbols" aria-hidden="true">local_fire_department</span>
            <span>${stats.streakDays} 天连续打卡</span>
          </span>
          <span class="monthly-view__stat-divider" aria-hidden="true">·</span>
          <span class="monthly-view__stat-item">
            <span class="material-symbols" aria-hidden="true">equalizer</span>
            <span>近30天平均完成率 ${stats.avgRate}%</span>
          </span>
        </div>
      </div>
    `

    this.bindEvents()
  }

  createCell(day) {
    // 透明度曲线：rate^(1/3) 前期递增快、后期放缓，让 50% 以下完成度的格子明显可辨；
    // 0% 完成度保持 0.15 下限（避免纯白/接近不可见），与 CSS 双重使用相乘后视觉更实
    const opacity = day.rate === 0 ? 0.15 : Math.pow(day.rate / 100, 1 / 3)
    const isFull = day.rate === 100
    const isToday = day.isToday
    // 搁置橙色态优先级高于完成率色阶（含满格绿），但完成数信息仍保留在 label 中。
    const cellClass = [
      'monthly-view__cell',
      day.hasSnoozed ? 'monthly-view__cell--snoozed' : '',
      !day.hasSnoozed && isFull ? 'monthly-view__cell--full' : '',
      isToday ? 'monthly-view__cell--today' : ''
    ].filter(Boolean).join(' ')

    return `
      <div class="${cellClass}"
           role="gridcell"
           data-date="${day.dateStr}"
           data-rate="${day.rate}"
           data-completed="${day.completed}"
           data-total="${day.total}"
           data-snoozed="${day.hasSnoozed ? '1' : '0'}"
           style="--cell-opacity: ${opacity}"
           tabindex="0"
           aria-label="${this.formatDisplayDate(day.date)} · ${day.rate}% · ${day.completed}/${day.total}任务${day.hasSnoozed ? ' · 已搁置' + day.snoozeSnapshots.length + '项' : ''}"
           aria-expanded="false">
        <span class="monthly-view__cell-inner"></span>
        <span class="monthly-view__cell-label">
          <span class="monthly-view__cell-label-date">${this.formatDisplayDate(day.date)}</span>
          <span class="monthly-view__cell-label-stats">${day.completed > 0 ? day.completed + '/' + day.total : '无数据'}</span>
        </span>
      </div>
    `
  }

  formatDisplayDate(date) {
    const month = date.getMonth() + 1
    const day = date.getDate()
    return `${month}月${day}日`
  }

  calculateStats(data) {
    const completedDays = data.filter(d => d.rate > 0).length
    const totalRate = data.reduce((sum, d) => sum + d.rate, 0)
    // 固定分母为 this.gridSize（30），无数据时返回 0
    const avgRate = this.gridSize > 0
      ? Math.round(totalRate / this.gridSize)
      : 0

    let streakDays = 0
    for (let i = 0; i < data.length; i++) {
      if (data[i].rate > 0) {
        streakDays++
      } else {
        break
      }
    }

    return {
      completedDays: completedDays,
      avgRate: avgRate,
      streakDays: streakDays
    }
  }

  bindEvents() {
    const cells = this.container.querySelectorAll('.monthly-view__cell')

    cells.forEach(cell => {
      cell.addEventListener('mouseenter', () => this.onCellEnter(cell))
      cell.addEventListener('mouseleave', () => this.onCellLeave(cell))
      cell.addEventListener('click', (e) => this.onCellClick(e, cell))
      cell.addEventListener('keydown', (e) => this.onCellKeydown(e, cell))
    })
  }

  onCellEnter(cell) {
    if (this.lockedCell) return
    this.showCellInfo(cell)
  }

  onCellLeave(cell) {
    if (this.lockedCell) return
    this.hideCellInfo(cell)
  }

  onCellClick(e, cell) {
    e.stopPropagation()

    if (this.lockedCell === cell) {
      // 第二步交互：格子已固定时再次点击，若为搁置格则打开详情弹窗，
      // 否则仅取消固定，避免空详情弹窗干扰普通日期。
      if (cell.getAttribute('data-snoozed') === '1') {
        this.openSnoozeDetailModal(cell)
      } else {
        this.hideCellInfo(cell)
        this.lockedCell = null
      }
      return
    }

    // 第一步交互：固定当前格子，同时收起其它已固定的格子。
    if (this.lockedCell) {
      this.hideCellInfo(this.lockedCell)
    }
    this.showCellInfo(cell)
    this.lockedCell = cell
  }

  /**
   * 打开搁置详情弹窗：任务名称快照与理由均使用 textContent 写入，
   * 杜绝用户输入（理由、任务标题）被当作 HTML 注入。
   */
  openSnoozeDetailModal(cell) {
    const day = this.findDayByDate(cell.getAttribute('data-date'))
    if (!day || !day.hasSnoozed) return
    this.populateSnoozeDetailModal(day)
    openModal('snoozeDetail')
  }

  findDayByDate(dateStr) {
    if (!dateStr) return null
    return this.getData().find((d) => d.dateStr === dateStr) || null
  }

  populateSnoozeDetailModal(day) {
    // 日期：同时写 datetime 属性供辅助技术读取 ISO 值，textContent 供视觉显示。
    const dateEl = document.getElementById('snooze-detail-date')
    if (dateEl) {
      dateEl.setAttribute('datetime', day.dateStr)
      dateEl.textContent = this.formatDisplayDate(day.date)
    }

    // 完成度：用图标 + 文本展示，避免纯文字显得孤立。
    const progressEl = document.getElementById('snooze-detail-progress')
    if (progressEl) {
      progressEl.innerHTML = ''
      const icon = document.createElement('span')
      icon.className = 'material-symbols'
      icon.setAttribute('aria-hidden', 'true')
      icon.textContent = day.total > 0 ? 'checklist' : 'info_off'
      const text = document.createElement('span')
      text.textContent = day.total > 0
        ? `${day.rate}% · 已完成 ${day.completed}/${day.total} 项`
        : '无数据'
      progressEl.append(icon, text)
    }

    // 任务列表：逐项 textContent 写入，防 HTML 注入；标题处显示任务数量徽章。
    const countEl = document.getElementById('snooze-detail-task-count')
    if (countEl) countEl.textContent = String(day.snoozeSnapshots.length)

    const listEl = document.getElementById('snooze-detail-task-list')
    if (listEl) {
      listEl.innerHTML = ''
      for (const snap of day.snoozeSnapshots) {
        const li = document.createElement('li')
        li.className = 'snooze-detail-task'
        li.textContent = snap.title || snap.id
        listEl.appendChild(li)
      }
    }

    // 理由：空态显示占位文案并标记 is-empty 以斜体弱化；非空时正常显示。
    const reasonEl = document.getElementById('snooze-detail-reason')
    if (reasonEl) {
      const empty = !day.snoozeReason
      reasonEl.textContent = empty ? I18N.monthly.snoozeDetailNoReason : day.snoozeReason
      reasonEl.classList.toggle('is-empty', empty)
    }
  }

  onCellKeydown(e, cell) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      e.stopPropagation()
      this.onCellClick(e, cell)
    }
  }

  showCellInfo(cell) {
    if (cell.classList.contains('monthly-view__cell--expanded')) return
    cell.classList.add('monthly-view__cell--expanded')
    cell.setAttribute('aria-expanded', 'true')
  }

  hideCellInfo(cell) {
    cell.classList.remove('monthly-view__cell--expanded')
    cell.setAttribute('aria-expanded', 'false')
  }
}

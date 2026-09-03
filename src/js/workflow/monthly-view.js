import { getCompletionHistory } from './history-store.js'
import { getWorkflows, onWorkflowsChange } from './workflow-store.js'
import { onHistoryChange } from './history-store.js'
import { onCompletedChange, getCompletedIds } from './completion-store.js'
import { getTodayDateString } from '../core/date.js'

export class MonthlyView {
  constructor(container) {
    this.container = container
    this.today = getTodayDateString()
    this.gridSize = 30
    this.columns = 5
    this.rows = 6
    this.lockedCell = null
    this._unsubscribeFns = []
    this._initSubscriptions()
  }

  _initSubscriptions() {
    this._subscribe(onWorkflowsChange, () => this.refresh())
    this._subscribe(onHistoryChange, () => this.refresh())
    this._subscribe(onCompletedChange, () => this.refresh())

    // 文档级键盘：Escape 关闭选中方格
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.lockedCell) {
        this.hideCellInfo(this.lockedCell)
        this.lockedCell = null
      }
    })

    // 文档级点击空白区域收起
    document.addEventListener('click', (e) => {
      if (this.lockedCell && !e.target.closest('.monthly-view__cell')) {
        this.hideCellInfo(this.lockedCell)
        this.lockedCell = null
      }
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
    this.container.innerHTML = ''
  }

  getData() {
    const history = getCompletionHistory()
    const workflows = getWorkflows()
    const totalTasks = workflows.length
    const todayCompletedIds = getCompletedIds()

    const data = []
    const today = new Date(this.today)

    for (let i = 0; i < this.gridSize; i++) {
      const date = new Date(today)
      date.setDate(date.getDate() - i)
      const dateStr = this.formatDate(date)

      // 今日使用实时完成状态，历史日期读取历史记录
      let completedCount
      if (dateStr === this.today) {
        completedCount = [...todayCompletedIds].filter(id =>
          workflows.some(w => w.id === id)
        ).length
      } else {
        completedCount = (history[dateStr] || []).length
      }

      const rate = totalTasks > 0
        ? Math.round((completedCount / totalTasks) * 100)
        : 0

      data.push({
        date: date,
        dateStr: dateStr,
        completed: completedCount,
        total: totalTasks,
        rate: rate,
        isToday: dateStr === this.today
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
    const opacity = Math.max(0.15, day.rate / 100)
    const isFull = day.rate === 100
    const isToday = day.isToday
    const cellClass = [
      'monthly-view__cell',
      isFull ? 'monthly-view__cell--full' : '',
      isToday ? 'monthly-view__cell--today' : ''
    ].filter(Boolean).join(' ')

    return `
      <div class="${cellClass}"
           role="gridcell"
           data-date="${day.dateStr}"
           data-rate="${day.rate}"
           data-completed="${day.completed}"
           data-total="${day.total}"
           style="--cell-opacity: ${opacity}"
           tabindex="0"
           aria-label="${this.formatDisplayDate(day.date)} · ${day.rate}% · ${day.completed}/${day.total}任务"
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
      this.hideCellInfo(cell)
      this.lockedCell = null
    } else {
      if (this.lockedCell) {
        this.hideCellInfo(this.lockedCell)
      }
      this.showCellInfo(cell)
      this.lockedCell = cell
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

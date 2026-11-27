import { DBG } from '../core/debug.js'
import { I18N, t } from '../locales.js'
import { getMemos, getMemoTags } from '../memo/memo-store.js'
import { getAnkiExportConfigForTag } from './anki-export-store.js'
import { validateAnkiExportFieldNames } from '../config/storage-config.js'
import { processAnkiText, acquireAnkiProcessing, releaseAnkiProcessing } from './anki-processor.js'
import { downloadBatchAnkiApkg, parseAnkiOutput, isAbnormalCategory } from './anki-output.js'
import { createGuard } from '../utils/guard.js'
import { escapeHtml } from '../utils/dom-utils.js'
import { showToast } from '../ui.js'
import { getActiveProfile } from './anki-store.js'
import { getCachedAnkiPrompt } from './anki-prompt.js'

const STATUS = Object.freeze({ waiting: 'waiting', processing: 'processing', success: 'success', failed: 'failed', cancelled: 'cancelled' })
let activeBatch = null
const selectedMemoIds = new Set()
const guardBatchEvents = createGuard('ankiBatchEventsBound')

function getBatchRoot() {
  return document.getElementById('memo-batch-toolbar')
}

/* ===== 卡片状态徽章 =====
 * 徽章的壳由 memo-renderer 建成（单条渲染与批量同步共用同一 DOM 结构），
 * 这里只负责填内容 / 切类。批量处理逐条刷新时只改已有节点、不重建卡片流，
 * 否则用户展开的长笔记会被收起、滚动位置也会跳。
 */
const STATUS_ICONS = Object.freeze({
  [STATUS.processing]: 'progress_activity',
  [STATUS.success]: 'check_circle',
  [STATUS.failed]: 'error',
  [STATUS.cancelled]: 'block'
})
const CARD_STATUS_CLASSES = Object.keys(STATUS_ICONS).map((status) => `memo-card--batch-${status}`)

export function applyMemoCardStatus(card, status) {
  if (!card) return
  card.classList.remove(...CARD_STATUS_CLASSES)
  const icon = STATUS_ICONS[status]
  if (icon) card.classList.add(`memo-card--batch-${status}`)
  const badge = card.querySelector('[data-memo-status]')
  if (!badge) return
  badge.hidden = !icon
  if (!icon) {
    badge.removeAttribute('data-status')
    return
  }
  badge.dataset.status = status
  const iconEl = badge.querySelector('.material-symbols')
  const labelEl = badge.querySelector('[data-memo-status-label]')
  if (iconEl) iconEl.textContent = icon
  if (labelEl) labelEl.textContent = I18N.memo.batchStatuses[status]
}

export function getMemoBatchStatus(id) {
  const item = activeBatch?.items?.find((entry) => Number(entry.id) === Number(id))
  return item?.status || ''
}

function syncMemoCardStatuses(batch = activeBatch) {
  const statusById = new Map((batch?.items || []).map((item) => [Number(item.id), item.status]))
  document.querySelectorAll('#memo-stream .memo-card').forEach((card) => {
    applyMemoCardStatus(card, statusById.get(Number(card.dataset.id)) || '')
  })
}

/**
 * 批量运行期间卡片上的勾选框与「Anki 处理」必须置灰：
 * 单条处理是单通道（acquireAnkiProcessing），此时点击本就会被拒绝，
 * 置灰让预期和行为一致，而不是点了没反应。
 */
function syncStreamControls(running) {
  document.querySelectorAll('#memo-stream .memo-card').forEach((card) => {
    const select = card.querySelector('.memo-card__select')
    if (select) select.disabled = running
    const ankiBtn = card.querySelector('.memo-card__anki')
    if (ankiBtn) ankiBtn.disabled = running
  })
}

/* ===== 批量面板渲染 ===== */

function setText(scope, selector, text) {
  const el = scope.querySelector(selector)
  if (el) el.textContent = text
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

function countByStatus(items, status) {
  return items.filter((item) => item.status === status).length
}

function setMenuOpen(root, open) {
  const menu = root.querySelector('[data-batch-menu]')
  const trigger = root.querySelector('[data-batch-action="more"]')
  if (!menu || !trigger) return
  menu.hidden = !open
  trigger.setAttribute('aria-expanded', open ? 'true' : 'false')
}

/**
 * 失败条目：整行可点，点击后定位到对应卡片。
 * 原因文本最多显示两行，完整内容放 title，避免超长报错把面板撑高。
 */
function createFailureRow(item, index, tagNames, grouped) {
  const li = makeEl('li', 'memo-batch__failure' + (grouped ? ' memo-batch__failure--grouped' : ''))
  const reason = item.error || I18N.memo.batchReasonUnknown

  const btn = makeEl('button', 'memo-batch__failure-main')
  btn.type = 'button'
  btn.dataset.batchJump = String(item.id)
  btn.setAttribute('aria-label', t(I18N.memo.batchJumpAria, { time: item.label || '' }))

  const head = makeEl('span', 'memo-batch__failure-head')
  head.append(makeEl('time', 'memo-batch__failure-time', item.label || ''))
  const tagName = tagNames.get(item.tag) || String(item.tag ?? '').replace(/^#/, '')
  if (tagName) head.append(makeEl('span', 'memo-tag-chip', tagName))

  const reasonEl = makeEl('span', 'memo-batch__failure-reason', reason)
  reasonEl.title = reason

  const body = makeEl('span', 'memo-batch__failure-body')
  body.append(head, reasonEl)

  const jumpIcon = makeEl('span', 'material-symbols memo-batch__failure-jump', 'arrow_outward')
  jumpIcon.setAttribute('aria-hidden', 'true')

  btn.append(makeEl('span', 'memo-batch__failure-index', String(index).padStart(2, '0')), body, jumpIcon)
  li.append(btn)
  return li
}

function renderFailureList(list, failedItems) {
  const tagNames = new Map(getMemoTags().map((tag) => [tag.id, tag.name]))
  // 同一原因 ≥3 条时合并成组：用户要修的是原因，重复十遍同样的报错只会淹没信息。
  const groups = new Map()
  for (const item of failedItems) {
    const reason = item.error || I18N.memo.batchReasonUnknown
    if (!groups.has(reason)) groups.set(reason, [])
    groups.get(reason).push(item)
  }

  const frag = document.createDocumentFragment()
  let index = 0
  for (const [reason, groupItems] of groups) {
    const grouped = groupItems.length >= 3
    if (grouped) frag.append(makeEl('li', 'memo-batch__failure-group', `${reason} · ${groupItems.length}`))
    for (const item of groupItems) {
      index += 1
      frag.append(createFailureRow(item, index, tagNames, grouped))
    }
  }
  list.replaceChildren(frag)
}

function renderBatch(root, batch) {
  if (!root) return
  const items = batch.items || []
  const total = items.length
  const success = countByStatus(items, STATUS.success)
  const failed = countByStatus(items, STATUS.failed)
  const cancelled = countByStatus(items, STATUS.cancelled)
  const done = success + failed + cancelled
  const current = items.find((item) => item.status === STATUS.processing)
  // 三段相位：idle（只选了没跑）/ running / done（跑完或中途取消）。
  // 相位变化才动折叠态，避免用户手动展开后被后续渲染反复合上。
  const phase = batch.running ? 'running' : (done > 0 ? 'done' : 'idle')

  let headline = t(I18N.memo.batchHeadlineIdle, { count: total })
  if (phase === 'running') headline = t(I18N.memo.batchHeadlineRunning, { current: current?.label || '' })
  else if (phase === 'done') {
    headline = success === 0 && failed === 0 ? I18N.memo.batchHeadlineCancelled : I18N.memo.batchHeadlineDone
  }
  setText(root, '[data-batch-headline]', headline)

  // 计数只在运行中/结束后出现：全 0 的「成功 0 · 失败 0 · 取消 0」没有信息量。
  const counts = root.querySelector('[data-batch-counts]')
  if (counts) counts.hidden = phase === 'idle'
  root.querySelectorAll('[data-batch-count]').forEach((chip) => {
    const value = { success, failed, cancelled }[chip.dataset.batchCount] ?? 0
    setText(chip, '.memo-batch__count-value', String(value))
    chip.classList.toggle('is-zero', value === 0)
  })

  const progress = root.querySelector('[data-batch-progress]')
  if (progress) progress.hidden = phase !== 'running'
  const track = root.querySelector('[data-batch-progress-bar]')
  if (track) {
    track.setAttribute('aria-valuemax', String(Math.max(total, 1)))
    track.setAttribute('aria-valuenow', String(done))
  }
  const fill = root.querySelector('[data-batch-progress-fill]')
  if (fill) fill.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%'
  setText(root, '[data-batch-progress-text]', `${done}/${total}`)

  // 失败详情：运行中收起（否则每失败一条就展开一截、页面持续跳动）；
  // 结束后若确有失败自动展开一次，之后尊重用户手动折叠。
  const failedItems = items.filter((item) => item.status === STATUS.failed)
  const details = root.querySelector('[data-batch-failures]')
  if (details) {
    details.hidden = failedItems.length === 0
    setText(root, '[data-batch-failures-label]', t(I18N.memo.batchFailureToggle, { count: failedItems.length }))
    if (batch.uiPhase !== phase) {
      details.open = phase === 'done' && failedItems.length > 0
      batch.uiPhase = phase
    }
    const list = details.querySelector('[data-batch-list]')
    if (list) renderFailureList(list, failedItems)
  }

  const run = root.querySelector('[data-batch-action="run"]')
  if (run) {
    run.hidden = batch.running
    run.disabled = total === 0
    setText(run, '[data-batch-run-label]', t(I18N.memo.batchRunCount, { count: total }))
  }
  const cancel = root.querySelector('[data-batch-action="cancel"]')
  if (cancel) cancel.hidden = !batch.running
  const clear = root.querySelector('[data-batch-action="clear"]')
  if (clear) clear.disabled = batch.running

  // 「下载」是结果型操作：拿到可用结果才出现，且收进更多菜单。
  const downloadable = !batch.running && (batch.results?.length || 0) > 0 && !batch.downloaded
  const more = root.querySelector('.memo-batch__more')
  const download = root.querySelector('[data-batch-action="download"]')
  if (more) more.hidden = !downloadable
  if (download) download.hidden = !downloadable
  if (!downloadable) setMenuOpen(root, false)

  syncMemoCardStatuses(batch)
  syncStreamControls(Boolean(batch.running))
}

function ensureBatchRoot() {
  const stream = document.getElementById('memo-stream')
  if (!stream) return null
  let root = getBatchRoot()
  if (root) return root
  root = document.createElement('section')
  root.id = 'memo-batch-toolbar'
  root.className = 'memo-batch'
  root.hidden = true
  root.innerHTML = `
    <div class="memo-batch__panel">
      <div class="memo-batch__top">
        <div class="memo-batch__status">
          <p class="memo-batch__headline" data-batch-headline aria-live="polite"></p>
          <div class="memo-batch__counts" data-batch-counts aria-label="${escapeHtml(I18N.memo.batchCountsAria)}" hidden>
            <span class="memo-batch__count" data-batch-count="success"><span class="memo-batch__count-label"></span><b class="memo-batch__count-value">0</b></span>
            <span class="memo-batch__count" data-batch-count="failed"><span class="memo-batch__count-label"></span><b class="memo-batch__count-value">0</b></span>
            <span class="memo-batch__count" data-batch-count="cancelled"><span class="memo-batch__count-label"></span><b class="memo-batch__count-value">0</b></span>
          </div>
        </div>
        <div class="memo-batch__actions">
          <button class="memo-batch__btn memo-batch__btn--primary" type="button" data-batch-action="run">
            <span class="material-symbols" aria-hidden="true">psychology</span><span data-batch-run-label>${t(I18N.memo.batchRunCount, { count: 0 })}</span>
          </button>
          <button class="memo-batch__btn memo-batch__btn--danger" type="button" data-batch-action="cancel" hidden>
            <span class="material-symbols" aria-hidden="true">stop_circle</span><span>${I18N.memo.batchCancel}</span>
          </button>
          <button class="memo-batch__btn" type="button" data-batch-action="clear">
            <span class="material-symbols" aria-hidden="true">close</span><span>${I18N.memo.batchClear}</span>
          </button>
          <div class="memo-batch__more" hidden>
            <button class="memo-batch__btn memo-batch__btn--icon" type="button" data-batch-action="more"
              aria-haspopup="menu" aria-expanded="false" aria-label="${escapeHtml(I18N.memo.batchMore)}">
              <span class="material-symbols" aria-hidden="true">more_horiz</span>
            </button>
            <div class="memo-batch__menu" data-batch-menu role="menu" aria-label="${escapeHtml(I18N.memo.batchMore)}" hidden>
              <button class="memo-batch__menu-item" type="button" role="menuitem" data-batch-action="download" hidden>
                <span class="material-symbols" aria-hidden="true">download</span><span>${I18N.memo.batchDownload}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      <div class="memo-batch__progress" data-batch-progress hidden>
        <div class="memo-batch__progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" data-batch-progress-bar>
          <div class="memo-batch__progress-fill" data-batch-progress-fill></div>
        </div>
        <span class="memo-batch__progress-text" data-batch-progress-text>0/0</span>
      </div>
    </div>
    <details class="memo-batch__failures" data-batch-failures hidden>
      <summary class="memo-batch__failures-summary">
        <span class="material-symbols" aria-hidden="true">error</span>
        <span data-batch-failures-label></span>
        <span class="material-symbols memo-batch__failures-chevron" aria-hidden="true">expand_more</span>
      </summary>
      <ol class="memo-batch__failure-list" data-batch-list></ol>
    </details>`
  stream.parentNode.insertBefore(root, stream)
  // 计数标签固定不变：建壳时写一次，后续只更新数值。
  root.querySelectorAll('[data-batch-count]').forEach((chip) => {
    const label = chip.querySelector('.memo-batch__count-label')
    if (label) label.textContent = I18N.memo.batchCounts[chip.dataset.batchCount] || ''
  })
  return root
}

function getMemoText(memo) {
  return String(memo?.content || '').trim()
}

function buildGroups(results) {
  const map = new Map()
  for (const result of results) {
    const key = result.tag
    if (!map.has(key)) map.set(key, { sections: [], tagConfig: result.tagConfig || getAnkiExportConfigForTag(key) })
    map.get(key).sections.push(...parseAnkiOutput(result.text))
  }
  return [...map.values()]
}

function validateConfig(tag, snapshot = getAnkiExportConfigForTag(tag)) {
  const config = snapshot
  if (!config?.deckName || !config?.modelName) return I18N.toast.anki.apkgConfigRequired
  const fieldError = validateAnkiExportFieldNames(config.fieldNames)
  if (!fieldError) return ''
  return fieldError.reason === 'duplicate'
    ? t(I18N.toast.anki.apkgFieldNamesDuplicate, { name: fieldError.name })
    : I18N.toast.anki.apkgFieldNamesEmpty
}

export function getActiveAnkiBatch() {
  return activeBatch
}

export function setMemoBatchSelection(ids) {
  if (activeBatch?.running) {
    document.querySelectorAll('#memo-stream .memo-card').forEach((card) => {
      const input = card.querySelector('.memo-card__select')
      if (input) input.checked = selectedMemoIds.has(Number(card.dataset.id))
    })
    return
  }
  const selected = new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite))
  selectedMemoIds.clear()
  selected.forEach((id) => selectedMemoIds.add(id))
  document.querySelectorAll('#memo-stream .memo-card').forEach((card) => {
    const checked = selected.has(Number(card.dataset.id))
    const input = card.querySelector('.memo-card__select')
    if (input) input.checked = checked
    card.classList.toggle('is-selected', checked)
  })
  const root = ensureBatchRoot()
  if (!root) return
  if (!activeBatch || activeBatch.running) {
    activeBatch = activeBatch || { items: [], results: [], running: false }
  }
  if (!activeBatch.running) {
    activeBatch.results = []
    activeBatch.downloaded = false
    activeBatch.frozen = false
  }
  activeBatch.items = [...selected].map((id) => {
    const memo = getMemos().find((item) => Number(item.id) === id)
    return memo ? { id, tag: memo.tag, label: memo.timestamp || String(id), memo, status: STATUS.waiting } : null
  }).filter(Boolean).sort((a, b) => a.id - b.id)
  root.hidden = activeBatch.items.length === 0
  renderBatch(root, activeBatch)
}

export function getSelectedMemoIds() {
  return [...selectedMemoIds]
}

export function reconcileMemoBatchSelection(memos = getMemos()) {
  if (activeBatch?.running) return
  const existing = new Map((Array.isArray(memos) ? memos : []).map((memo) => [Number(memo.id), memo]))
  for (const id of selectedMemoIds) {
    if (!existing.has(id)) selectedMemoIds.delete(id)
  }
  if (activeBatch) {
    if (!activeBatch.frozen) {
      activeBatch.items = activeBatch.items.filter((item) => existing.has(item.id)).map((item) => {
        const memo = existing.get(item.id)
        return { ...item, memo, tag: memo.tag, label: memo.timestamp || String(memo.id) }
      })
      // 已删除笔记的成功结果一并丢弃，避免"条目已消失、导出里却还有"。
      if (Array.isArray(activeBatch.results)) {
        activeBatch.results = activeBatch.results.filter((result) => existing.has(Number(result.id)))
      }
    }
    const root = getBatchRoot()
    if (root) {
      root.hidden = activeBatch.items.length === 0
      renderBatch(root, activeBatch)
    }
  }
  const root = getBatchRoot()
  if (root && !activeBatch?.items?.length) root.hidden = true
}

export function isMemoBatchRunning() {
  return Boolean(activeBatch?.running)
}

export function clearMemoBatch() {
  if (activeBatch?.running) return
  activeBatch = null
  selectedMemoIds.clear()
  document.querySelectorAll('#memo-stream .memo-card__select').forEach((input) => { input.checked = false })
  document.querySelectorAll('#memo-stream .memo-card.is-selected').forEach((card) => card.classList.remove('is-selected'))
  // 批量状态是挂载在卡片上的视觉态，清空批次必须同步摘掉，否则会残留成功/失败色条。
  syncMemoCardStatuses(null)
  const root = getBatchRoot()
  if (root) root.hidden = true
}

export function cancelMemoBatch() {
  if (!activeBatch?.running) return
  activeBatch.cancelled = true
  activeBatch.controller?.abort()
}

export async function runMemoBatch() {
  if (!activeBatch?.items?.length || activeBatch.running || !acquireAnkiProcessing()) return
  const root = ensureBatchRoot()
  if (!root) {
    releaseAnkiProcessing()
    return
  }
  const batch = {
    ...activeBatch,
    items: activeBatch.items.map((item) => {
      const tagConfig = getAnkiExportConfigForTag(item.tag)
      return {
        ...item,
        memo: { ...item.memo },
        tagConfig: { ...tagConfig, fieldNames: [...(tagConfig?.fieldNames || [])] }
      }
    }),
    profile: { ...getActiveProfile() },
    systemPrompt: getCachedAnkiPrompt(),
    frozen: true,
    results: [],
    running: true,
    cancelled: false,
    downloaded: false
  }
  activeBatch = batch
  batch.items.forEach((item) => { item.status = STATUS.waiting; item.error = '' })
  renderBatch(root, batch)
  try {
    for (const item of batch.items) {
      if (batch.cancelled) {
        item.status = STATUS.cancelled
        renderBatch(root, batch)
        continue
      }
      const configError = validateConfig(item.tag, item.tagConfig)
      if (configError) {
        item.status = STATUS.failed
        item.error = configError
        renderBatch(root, batch)
        continue
      }
      item.status = STATUS.processing
      batch.controller = new AbortController()
      renderBatch(root, batch)
      let result
      try {
        result = await processAnkiText(getMemoText(item.memo), {
          signal: batch.controller.signal,
          profile: batch.profile,
          systemPrompt: batch.systemPrompt
        })
      } catch (err) {
        result = { ok: false, error: I18N.toast.anki.aiFailed, code: '' }
      }
      if (result.code === 'aborted' || batch.cancelled) {
        item.status = STATUS.cancelled
      } else if (result.ok) {
        // 逐篇阶段即完成解析校验：解析不出可用内容（无有效分类文本）立即标失败，
        // 不拖到下载阶段才以 empty-export 暴露。
        const sections = parseAnkiOutput(result.text)
        const hasUsable = sections.some((section) => !isAbnormalCategory(section.name) && String(section.text || '').trim())
        if (hasUsable) {
          item.status = STATUS.success
          batch.results.push({ id: item.id, tag: item.tag, text: result.text, tagConfig: item.tagConfig })
        } else {
          item.status = STATUS.failed
          item.error = I18N.toast.anki.batchParseFailed
        }
      } else {
        item.status = STATUS.failed
        item.error = result.error || I18N.toast.anki.aiFailed
      }
      renderBatch(root, batch)
    }
  } catch (err) {
    const current = batch.items.find((item) => item.status === STATUS.processing)
    if (current) {
      current.status = STATUS.failed
      current.error = I18N.toast.anki.aiError
    }
    // 批次级异常：未执行的条目显式标记为已取消并计入汇总，不留在"等待"状态。
    batch.items.forEach((item) => {
      if (item.status === STATUS.waiting) item.status = STATUS.cancelled
    })
    DBG('anki:batch:exception', { name: err?.name || 'Error' })
    showToast(I18N.toast.anki.aiError, { status: 'error' })
  } finally {
    batch.running = false
    batch.controller = null
    // 批次结束（成功/失败/取消/异常）即解冻：条目重新对齐实时数据，
    // 已删除的笔记由 reconcile 剔除，重新开跑时取到的是最新内容快照。
    batch.frozen = false
    reconcileMemoBatchSelection()
    renderBatch(root, batch)
    releaseAnkiProcessing()
  }
}

let jumpFlashTimer = null

/**
 * 失败条目跳转：只滚动 + 临时高亮，不改变选中态、不切页签。
 * 目标卡片可能被删除或被当前筛选标签隐藏，此时给出解释而不是静默失败。
 */
function jumpToMemo(id) {
  const card = document.querySelector(`#memo-stream .memo-card[data-id="${id}"]`)
  if (!card) {
    showToast(I18N.memo.batchJumpMissing, { status: 'info' })
    return
  }
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  card.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' })
  if (jumpFlashTimer) window.clearTimeout(jumpFlashTimer)
  card.classList.add('is-batch-jump-target')
  jumpFlashTimer = window.setTimeout(() => {
    card.classList.remove('is-batch-jump-target')
    jumpFlashTimer = null
  }, 1400)
}

export function bindMemoBatchEvents() {
  const root = ensureBatchRoot()
  if (!root || guardBatchEvents.is(document)) return
  guardBatchEvents.set(document)
  root.addEventListener('click', async (event) => {
    const jump = event.target.closest('[data-batch-jump]')
    if (jump) {
      jumpToMemo(Number(jump.dataset.batchJump))
      return
    }
    const action = event.target.closest('button[data-batch-action]')?.dataset.batchAction
    if (!action) return
    if (action === 'more') {
      const menu = root.querySelector('[data-batch-menu]')
      setMenuOpen(root, Boolean(menu?.hidden))
      return
    }
    setMenuOpen(root, false)
    if (action === 'run') runMemoBatch().catch((err) => DBG('anki:batch:run-error', { name: err?.name || 'Error' }))
    else if (action === 'cancel') cancelMemoBatch()
    else if (action === 'clear') clearMemoBatch()
    else if (action === 'download' && activeBatch?.results?.length) {
      const result = await downloadBatchAnkiApkg(buildGroups(activeBatch.results), { noteCount: activeBatch.results.length })
      activeBatch.downloaded = Boolean(result.ok)
      renderBatch(root, activeBatch)
    }
  })
  // 菜单是浮层：点面板外或按 Esc 收起，避免留下一个看不见的展开态。
  document.addEventListener('click', (event) => {
    if (!root.contains(event.target)) setMenuOpen(root, false)
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setMenuOpen(root, false)
  })
}

export { STATUS as ANKI_BATCH_STATUS }

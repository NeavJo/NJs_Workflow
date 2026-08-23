import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N, t } from '../locales.js'
import { getSelectedMemoTag, setSelectedMemoTag, appendOrDailyMemo, deleteMemo, updateMemoContent, updateMemoTag, getMemos, loadMemos } from './memo-store.js'
import { renderMemos, renderMemoTagPickerList, renderMemoTagPickerTrigger, renderTagSelector } from './memo-renderer.js'
import { openModal, closeModal, isModalOpen } from '../settings/modal.js'
import { switchView } from '../settings/navigation.js'
import { bindBatch, bindOnce } from '../utils/event-manager.js'
import { uploadToGist } from '../backup/gist-sync.js'

/**
 * 笔记事件层：表单提交、刷新、标签选择、卡片按钮（编辑/保存/取消/删除/复制）。
 * 全部用事件委托，少量直接绑定到表单控件。
 */

function focusMemoInput() {
  const s = document.getElementById('memo-word-input')
  if (s) setTimeout(() => s.focus({ preventScroll: true }), 0)
}

function setTagPickerExpanded(expanded) {
  const trigger = document.getElementById('memo-tag-picker-trigger')
  if (trigger) trigger.setAttribute('aria-expanded', expanded ? 'true' : 'false')
}

function openMemoTagPicker() {
  renderMemoTagPickerList()
  setTagPickerExpanded(true)
  openModal('memo-tag-picker')
}

function closeMemoTagPicker() {
  setTagPickerExpanded(false)
  closeModal('memo-tag-picker')
}

function handleCardAction(card, action) {
  const id = Number(card.dataset.id)
  if (!id) return

  if (action === 'edit') {
    enterEditMode(card, id)
  } else if (action === 'cancel') {
    exitEditMode(card)
  } else if (action === 'save') {
    const editor = card.querySelector('.memo-card__editor')
    const tagSelect = card.querySelector('.memo-tag-select')
    if (editor && tagSelect) {
      const next = (editor.value || '').trim()
      if (!next) {
        showToast('内容不能为空，如需删除请用删除按钮。')
        return
      }
      const contentOk = updateMemoContent(id, next)
      const tagOk = updateMemoTag(id, tagSelect.value)
      if (contentOk && tagOk) {
        exitEditMode(card)
        showToast('笔记已更新。')
      }
    }
  } else if (action === 'delete') {
  if (!confirm('确认删除这条笔记？')) return
  if (deleteMemo(id)) {
    showToast('笔记已删除。')
    // 添加Gist上传触发
    uploadToGist()
  }
} else if (action === 'copy') {
    copyMemoContent(card)
  } else if (action === 'anki') {
    processInAnki(card)
  }
}

function enterEditMode(card, id) {
  const memos = getMemos()
  const memo = memos.find((m) => m.id === id)
  if (!memo) return
  const editor = card.querySelector('.memo-card__editor')
  const contentEl = card.querySelector('.memo-card__content')
  const tagChip = card.querySelector('.memo-tag-chip--display')
  const tagSelect = card.querySelector('.memo-tag-select')
  const editBtn = card.querySelector('.memo-card__edit')
  const saveBtn = card.querySelector('.memo-card__save')
  const cancelBtn = card.querySelector('.memo-card__cancel')
  const deleteBtn = card.querySelector('.memo-card__delete')
  const copyBtn = card.querySelector('.memo-card__copy')

  if (!editor) return
  editor.value = memo.content
  editor.hidden = false
  if (contentEl) contentEl.hidden = true
  if (tagChip) tagChip.hidden = true
  if (tagSelect) {
    tagSelect.hidden = false
    tagSelect.value = memo.tag
  }
  if (editBtn) editBtn.hidden = true
  if (saveBtn) saveBtn.hidden = false
  if (cancelBtn) cancelBtn.hidden = false
  if (deleteBtn) deleteBtn.hidden = true
  if (copyBtn) copyBtn.hidden = true
  card.classList.add('is-editing')
  setTimeout(() => editor.focus(), 0)
}

function exitEditMode(card) {
  const editor = card.querySelector('.memo-card__editor')
  const contentEl = card.querySelector('.memo-card__content')
  const tagChip = card.querySelector('.memo-tag-chip--display')
  const tagSelect = card.querySelector('.memo-tag-select')
  const editBtn = card.querySelector('.memo-card__edit')
  const saveBtn = card.querySelector('.memo-card__save')
  const cancelBtn = card.querySelector('.memo-card__cancel')
  const deleteBtn = card.querySelector('.memo-card__delete')
  const copyBtn = card.querySelector('.memo-card__copy')

  if (editor) editor.hidden = true
  if (contentEl) contentEl.hidden = false
  if (tagChip) tagChip.hidden = false
  if (tagSelect) tagSelect.hidden = true
  if (editBtn) editBtn.hidden = false
  if (saveBtn) saveBtn.hidden = true
  if (cancelBtn) cancelBtn.hidden = true
  if (deleteBtn) deleteBtn.hidden = false
  if (copyBtn) copyBtn.hidden = false
  card.classList.remove('is-editing')
}

async function copyMemoContent(card) {
  const editor = card.querySelector('.memo-card__editor')
  const contentEl = card.querySelector('.memo-card__content')
  const isEditing = editor && !editor.hidden
  const text = isEditing ? editor.value : (contentEl ? contentEl.textContent : '')
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
    } else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    showToast(I18N.toast.memo.copied)
  } catch (e) {
    DBG('memo:copy:error', String(e))
    showToast(I18N.toast.memo.copyFailed)
  }
}

async function processInAnki(card) {
  const editor = card.querySelector('.memo-card__editor')
  const contentEl = card.querySelector('.memo-card__content')
  const isEditing = editor && !editor.hidden
  const text = isEditing ? editor.value : (contentEl ? contentEl.textContent : '')
  
  const inputEl = document.getElementById('anki-input')
  if (!inputEl) {
    showToast('未找到Anki处理机输入框')
    return
  }
  
  inputEl.value = text
  showToast('已复制到Anki处理机')
  
  switchView('anki')
}

export function bindMemoEvents() {
  const wordInput = document.getElementById('memo-word-input')
  const categoryInput = document.getElementById('memo-category-input')
  const appendBtn = document.getElementById('memo-btn-append')
  const refreshBtn = document.querySelector('.view--memo .icon-button')
  const stream = document.getElementById('memo-stream')
  const tagSelector = document.querySelector('.tag-selector')

  const submitAppend = () => {
    const word = (wordInput?.value || '').trim()
    if (!word) {
      showToast(I18N.toast.memo.inputEmpty)
      focusMemoInput()
      return
    }
    const category = (categoryInput?.value || '').trim() || I18N.memo.defaultCategory
    const r = appendOrDailyMemo(word, getSelectedMemoTag(), category)
    if (r) {
      const tagName = getSelectedMemoTag()
      showToast(
        r.mode === 'append'
          ? t(I18N.toast.memo.appendedTo, { tag: tagName, category: r.category })
          : t(I18N.toast.memo.createdToday, { tag: tagName, category: r.category })
      )
      wordInput.value = ''
    }
    focusMemoInput()
  }

  // 批量绑定表单相关事件
  const formEvents = [
    {
      element: appendBtn,
      event: 'click',
      handler: submitAppend
    },
    {
      element: wordInput,
      event: 'keydown',
      handler: (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          submitAppend()
        }
      }
    },
    {
      element: categoryInput,
      event: 'keydown',
      handler: (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          focusMemoInput()
        }
      }
    },
    {
      element: refreshBtn,
      event: 'click',
      handler: () => {
        loadMemos()
        renderMemos()
        showToast(I18N.toast.memo.reloaded)
      }
    },
    {
      element: tagSelector,
      event: 'click',
      handler: (event) => {
        const btn = event.target.closest('[data-action="select-tag"]')
        if (!btn) return
        const id = btn.dataset.value
        if (setSelectedMemoTag(id)) {
          renderTagSelector()
          focusMemoInput()
        }
      }
    }
  ]

  // 绑定表单事件
  formEvents.forEach(({ element, event, handler }) => {
    if (element) {
      bindBatch(element, [{ event, handler }])
    }
  })

  /* 移动端：标签触发器 -> 底部弹窗选择 */
  const tagPickerTrigger = document.getElementById('memo-tag-picker-trigger')
  if (tagPickerTrigger) {
    bindBatch(tagPickerTrigger, [{
      event: 'click',
      handler: () => {
        if (isModalOpen('memo-tag-picker')) return
        openMemoTagPicker()
      }
    }])
  }

  const tagPickerList = document.getElementById('memo-tag-picker-list')
  if (tagPickerList) {
    bindBatch(tagPickerList, [{
      event: 'click',
      handler: (event) => {
        const btn = event.target.closest('[data-action="select-memo-tag-from-sheet"]')
        if (!btn) return
        const id = btn.dataset.value
        if (!id) return
        if (setSelectedMemoTag(id)) {
          closeMemoTagPicker()
        } else {
          closeMemoTagPicker()
        }
      }
    }])
  }

  /* 弹窗外的关闭按钮（防御：若 sheet 内 click 被消费，回退到通用 data-close-modal） */
  const tagPickerModal = document.getElementById('memo-tag-picker-modal')
  if (tagPickerModal) {
    bindBatch(tagPickerModal, [{
      event: 'click',
      handler: (event) => {
        if (event.target.closest('[data-close-modal="memo-tag-picker"]')) {
          setTagPickerExpanded(false)
        }
      }
    }])
  }

  // 批量绑定流区域事件
  if (stream) {
    const streamEvents = [
      {
        event: 'click',
        handler: (event) => {
          const btn = event.target.closest('button[data-memo-action]')
          if (!btn) return
          const card = btn.closest('.memo-card')
          if (!card) return
          handleCardAction(card, btn.dataset.memoAction)
        }
      },
      {
        event: 'keydown',
        handler: (event) => {
          const editor = event.target.closest('.memo-card__editor')
          if (!editor) return
          const card = editor.closest('.memo-card')
          if (!card) return
          const modifier = event.metaKey || event.ctrlKey
          if (modifier && event.key === 'Enter') {
            event.preventDefault()
            handleCardAction(card, 'save')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            exitEditMode(card)
          }
        }
      }
    ]

    bindBatch(stream, streamEvents)
  }

  // 返回清理函数，用于组件销毁时清理事件
  return () => {
    // 清理所有绑定的事件
    formEvents.forEach(({ element }) => {
      if (element) {
        // 清理事件监听器
        element.replaceWith(element.cloneNode(true))
      }
    })
    
    if (stream) {
      stream.replaceWith(stream.cloneNode(true))
    }
    
    if (tagSelector) {
      tagSelector.replaceWith(tagSelector.cloneNode(true))
    }
  }
}

import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N, t } from '../locales.js'
import { getMemoTags, addMemoTag as addMemoTagStore, deleteMemoTag as deleteMemoTagStore, renameMemoTag, persistMemoTags } from '../memo/memo-store.js'
import { renderTagSelector, renderMemos } from '../memo/memo-renderer.js'
import { uploadToGist } from '../backup/gist-sync.js'

/**
 * 标签设置页：列表渲染 + 新增 / 重命名 / 删除。
 * 全部操作经由 memo-store，UI 只读 store 后渲染。
 */

export function renderSettingsTagList() {
  const list = document.getElementById('settings-tag-list')
  if (!list) return
  const memoTags = getMemoTags()
  list.replaceChildren(
    ...memoTags.map((tag) => {
      const li = document.createElement('li')
      li.className = 'settings-tag-row' + (tag.isLocked ? ' is-locked' : '')
      li.dataset.id = tag.id

      const info = document.createElement('div')
      info.className = 'settings-tag-row__info'
      info.innerHTML = `<span class="material-symbols" aria-hidden="true">${tag.icon}</span><span class="settings-tag-row__name"></span>`
      info.querySelector('.settings-tag-row__name').textContent = tag.name

      const actions = document.createElement('div')
      actions.className = 'settings-tag-row__actions'
      if (tag.isLocked) {
        actions.innerHTML = `<span class="settings-tag-row__lock"><span class="material-symbols" aria-hidden="true">lock</span>${I18N.common.systemDefault}</span>`
      } else {
        const editBtn = document.createElement('button')
        editBtn.type = 'button'
        editBtn.className = 'icon-btn-mini'
        editBtn.title = I18N.settings.renameAria
        editBtn.setAttribute('aria-label', t(I18N.settings.renameTagAria, { name: tag.name }))
        editBtn.innerHTML = `<span class="material-symbols" aria-hidden="true">edit</span>`
        editBtn.dataset.action = 'rename-memo-tag'
        editBtn.dataset.id = tag.id

        const delBtn = document.createElement('button')
        delBtn.type = 'button'
        delBtn.className = 'icon-btn-mini icon-btn-mini--danger'
        delBtn.title = I18N.settings.deleteAria
        delBtn.setAttribute('aria-label', t(I18N.settings.deleteTagAria, { name: tag.name }))
        delBtn.innerHTML = `<span class="material-symbols" aria-hidden="true">delete</span>`
        delBtn.dataset.action = 'delete-memo-tag'
        delBtn.dataset.id = tag.id

        actions.append(editBtn, delBtn)
      }

      li.append(info, actions)
      return li
    })
  )
}

export function addMemoTagFromInput() {
  const input = document.getElementById('settings-tag-input')
  if (!input) return
  const name = input.value.trim()
  if (!name) {
    showToast(I18N.toast.memo.tagNameEmpty)
    return
  }
  const id = `#${name}`
  if (getMemoTags().find((t) => t.id === id)) {
    showToast(I18N.toast.memo.tagExists)
    return
  }
  addMemoTagStore({ id, name, icon: 'label', isLocked: false })
  persistMemoTags()
  renderSettingsTagList()
  renderTagSelector()
  input.value = ''
  input.focus()
  showToast(t(I18N.toast.memo.tagAdded, { name }))
  // 触发 Gist 上传；失败不影响本地操作，吞掉 rejection 防止未捕获异常
  uploadToGist().catch((err) => DBG('tag:settings:add:gist', String(err)))
}

export function startEditMemoTag(id) {
  const row = document.querySelector(`.settings-tag-row[data-id="${CSS.escape(id)}"]`)
  if (!row) return
  const memoTags = getMemoTags()
  const tag = memoTags.find((t) => t.id === id)
  if (!tag || tag.isLocked) return

  const nameEl = row.querySelector('.settings-tag-row__name')
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'settings-tag-row__edit-input'
  input.value = tag.name
  input.maxLength = 24
  nameEl.replaceWith(input)
  input.focus()
  input.select()

  const commit = () => {
    const newName = input.value.trim()
    if (newName && newName !== tag.name) {
      renameMemoTag(id, newName)
      renderTagSelector()
      renderMemos()
      showToast(t(I18N.toast.memo.tagRenamed, { name: newName }))
    }
    renderSettingsTagList()
  }
  const cancel = () => renderSettingsTagList()

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit() }
    else if (e.key === 'Escape') { e.preventDefault(); cancel() }
  })
  input.addEventListener('blur', commit)
}

export function deleteMemoTagFromSettings(id) {
  const memoTags = getMemoTags()
  const tag = memoTags.find((t) => t.id === id)
  if (!tag || tag.isLocked) return
  if (!window.confirm(t(I18N.toast.memo.deleteTagConfirm, { name: tag.name }))) return
  deleteMemoTagStore(id)
  renderSettingsTagList()
  renderTagSelector()
  renderMemos()
  showToast(t(I18N.toast.memo.tagDeleted, { name: tag.name }))
  
  // 添加Gist上传触发
  uploadToGist().catch((err) => DBG('tag:settings:delete:gist', String(err)))
}

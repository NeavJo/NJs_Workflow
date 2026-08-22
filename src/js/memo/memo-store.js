import { DBG } from '../core/debug.js'
import { MEMO_STORAGE_KEY } from '../core/storage.js'
import { safeStorageGet, safeStorageSet } from '../core/storage.js'
import { MEMO_TAGS_STORAGE_KEY, DEFAULT_MEMO_TAGS, normalizeMemoTagList } from '../config/memo-tags.js'
import { getTodayDateString, getFullTimestamp } from '../core/date.js'
import { cleanExpiredMemos } from './memo-retention.js'
import { appendToCategory } from './memo-parser.js'
import { requestAutoUpload } from '../core/sync-hooks.js'

/**
 * 笔记状态源：memos 数组 + memoTags + 当前选中标签。
 * 所有变更走 store 函数，事件层通过 onMemosChange / onMemoTagsChange 订阅刷新。
 */

const changeListeners = new Set()
const tagChangeListeners = new Set()

let memos = []
let memoTags = []
let selectedMemoTag = ''

function emitMemosChange() {
  for (const fn of changeListeners) {
    try { fn(memos) } catch (e) { DBG('memo:listener:error', String(e)) }
  }
}

function emitTagsChange() {
  for (const fn of tagChangeListeners) {
    try { fn({ tags: memoTags, selectedId: selectedMemoTag }) } catch (e) { DBG('memoTag:listener:error', String(e)) }
  }
}

function persistMemosImpl() {
  const ok = safeStorageSet(MEMO_STORAGE_KEY, memos)
  DBG('persist:memos', { length: memos.length, ok })
  requestAutoUpload()
  return ok
}

function persistMemoTagsImpl() {
  const ok = safeStorageSet(MEMO_TAGS_STORAGE_KEY, memoTags)
  DBG('persist:memoTags', { count: memoTags.length, ok })
  return ok
}

export function loadMemos() {
  const raw = safeStorageGet(MEMO_STORAGE_KEY, [])
  memos = Array.isArray(raw) ? raw : []
  DBG('init:memos', { length: memos.length })
  return memos
}

export function loadMemoTags() {
  const raw = safeStorageGet(MEMO_TAGS_STORAGE_KEY, null)
  const normalized = normalizeMemoTagList(raw)
  DBG('init:memoTags', { count: normalized.length, ids: normalized.map((t) => t.id) })
  memoTags = normalized
  if (!selectedMemoTag || !memoTags.find((t) => t.id === selectedMemoTag)) {
    selectedMemoTag = memoTags[0]?.id || DEFAULT_MEMO_TAGS[0].id
  }
  return memoTags
}

export function getMemos() {
  return memos
}

export function getMemoTags() {
  return memoTags
}

export function getSelectedMemoTag() {
  return selectedMemoTag
}

export function setSelectedMemoTag(id) {
  if (!memoTags.find((t) => t.id === id)) return false
  selectedMemoTag = id
  emitTagsChange()
  return true
}

export function persistMemos() {
  const ok = persistMemosImpl()
  return ok
}

export function persistMemoTags() {
  return persistMemoTagsImpl()
}

export function replaceMemos(next) {
  memos = Array.isArray(next) ? next : []
  emitMemosChange()
  return memos
}

export function addMemoTag(tag) {
  if (!tag || !tag.id) return false
  if (memoTags.find((t) => t.id === tag.id)) return false
  memoTags.push(tag)
  const ok = persistMemoTagsImpl()
  emitTagsChange()
  return ok
}

export function deleteMemoTag(id) {
  const before = memoTags.length
  memoTags = memoTags.filter((t) => t.id !== id)
  if (memoTags.length === before) return false
  if (selectedMemoTag === id) {
    selectedMemoTag = memoTags[0]?.id || DEFAULT_MEMO_TAGS[0].id
  }
  const ok = persistMemoTagsImpl()
  emitTagsChange()
  return ok
}

export function renameMemoTag(id, newName) {
  const tag = memoTags.find((t) => t.id === id)
  if (!tag || tag.isLocked) return false
  const next = (newName || '').trim()
  if (!next || next === tag.name) return false
  tag.name = next
  const ok = persistMemoTagsImpl()
  emitTagsChange()
  return ok
}

/**
 * 快速追加：若当日同 Tag 的卡片存在则追加到指定分类块；否则新建并置顶。
 * @returns {{ mode: 'append'|'create', memo: object, word: string, category: string } | null}
 */
export function appendOrDailyMemo(inputWord, currentTag, category = '常规') {
  const word = (inputWord || '').trim()
  if (!word) return null
  const tag = currentTag || selectedMemoTag
  const cat = (category || '').trim() || '常规'

  const todayStr = getTodayDateString()
  const targetMemo = memos.find(
    (m) => m.tag === tag && String(m.timestamp || '').startsWith(todayStr)
  )

  let mode
  if (targetMemo) {
    targetMemo.content = appendToCategory(targetMemo.content, cat, word)
    targetMemo.timestamp = getFullTimestamp()
    const newId = Date.now()
    if (newId !== targetMemo.id) targetMemo.id = newId
    mode = 'append'
  } else {
    const now = new Date()
    const memo = {
      id: now.getTime(),
      timestamp: getFullTimestamp(now),
      tag,
      content: appendToCategory('', cat, word)
    }
    memos.unshift(memo)
    mode = 'create'
  }

  cleanExpiredMemosInPlace()
  const persisted = persistMemosImpl()
  if (!persisted) return null
  emitMemosChange()
  return { mode, memo: targetMemo || memos[0], word, category: cat }
}

export function addMemo(content, tag, category = '常规') {
  const cleaned = (content || '').trim()
  if (!cleaned) return null
  const useTag = tag || selectedMemoTag
  const cat = (category || '').trim() || '常规'
  const now = new Date()
  const memo = {
    id: now.getTime(),
    timestamp: getFullTimestamp(now),
    tag: useTag,
    content: appendToCategory('', cat, cleaned)
  }
  memos.unshift(memo)
  cleanExpiredMemosInPlace()
  const persisted = persistMemosImpl()
  if (!persisted) return null
  emitMemosChange()
  return memo
}

export function deleteMemo(id) {
  const before = memos.length
  memos = memos.filter((m) => m.id !== id)
  if (memos.length === before) return false
  const ok = persistMemosImpl()
  emitMemosChange()
  return ok
}

export function updateMemoContent(id, nextContent) {
  const memo = memos.find((m) => m.id === id)
  if (!memo) return false
  memo.content = (nextContent || '').replace(/\r\n/g, '\n')
  memo.timestamp = getFullTimestamp()
  const newId = Date.now()
  if (newId !== memo.id) memo.id = newId
  const ok = persistMemosImpl()
  emitMemosChange()
  return ok
}

export function updateMemoTag(id, nextTag) {
  const memo = memos.find((m) => m.id === id)
  if (!memo) return false
  memo.tag = nextTag
  const ok = persistMemosImpl()
  emitMemosChange()
  return ok
}

function cleanExpiredMemosInPlace() {
  // 委托给 memo-retention，但只对 store 内部 memos 起作用
  const before = memos.length
  cleanExpiredMemos(memos)
  if (memos.length !== before) {
    DBG('memo:clean:expired', { removed: before - memos.length })
  }
}

export function onMemosChange(fn) {
  changeListeners.add(fn)
  return () => changeListeners.delete(fn)
}

export function onMemoTagsChange(fn) {
  tagChangeListeners.add(fn)
  return () => tagChangeListeners.delete(fn)
}

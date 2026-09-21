import { DBG } from '../core/debug.js'
import { MEMO_STORAGE_KEY } from '../core/storage.js'
import { I18N } from '../locales.js'
import { safeStorageGet, safeStorageSet } from '../core/storage.js'
import { MEMO_TAGS_STORAGE_KEY, DEFAULT_MEMO_TAGS, normalizeMemoTagList } from '../config/memo-tags.js'
import { getTodayDateString, getFullTimestamp } from '../core/date.js'
import { cleanExpiredMemos } from './memo-retention.js'
import { appendToCategory } from './memo-parser.js'
import { requestAutoUpload } from '../core/sync-hooks.js'
import { createPubSub } from '../utils/pubsub.js'

/**
 * 笔记状态源：memos 数组 + memoTags + 当前选中标签。
 * 所有变更走 store 函数，事件层通过 onMemosChange / onMemoTagsChange 订阅刷新。
 */

const memosPubsub = createPubSub()
const tagsPubsub = createPubSub()

let memos = []
let memoTags = []
let selectedMemoTag = ''
// 当前分类（如"常规"）。生词本记事本页面的分类输入框会实时写入，
// 其他模块（如德语助手"添加到生词本"）读取此值，保证跨页面分类联动。
// 不落盘：与 selectedMemoTag 保持一致的策略，刷新后回到默认分类，
// 避免在生词本页面残留的分类被误套用到其它场景。
let selectedMemoCategory = ''

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

export function setMemoTags(tags) {
  memoTags = Array.isArray(tags) ? normalizeMemoTagList(tags) : []
  if (!selectedMemoTag || !memoTags.find((t) => t.id === selectedMemoTag)) {
    selectedMemoTag = memoTags[0]?.id || DEFAULT_MEMO_TAGS[0].id
  }
  tagsPubsub.emit({ tags: memoTags, selectedId: selectedMemoTag })
  return memoTags
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
  tagsPubsub.emit({ tags: memoTags, selectedId: selectedMemoTag })
  return true
}

/**
 * 读取当前分类。
 * 返回空字符串表示用户尚未在生词本页面指定分类，
 * 调用方（如 appendOrDailyMemo）需回退到 I18N.memo.defaultCategory。
 */
export function getSelectedMemoCategory() {
  return selectedMemoCategory
}

/**
 * 记录生词本当前使用的分类。
 * 由 memo-events 的分类输入框在用户输入/清空时调用，使德语助手等
 * 其它调用 appendOrDailyMemo 的模块能自动继承该分类。
 * 传入空字符串代表清空为"跟随默认"。
 */
export function setSelectedMemoCategory(name) {
  selectedMemoCategory = String(name || '').trim()
}

export function persistMemos() {
  const ok = persistMemosImpl()
  return ok
}

export function persistMemoTags() {
  return persistMemoTagsImpl()
}

export function replaceMemos(next) {
  memos = Array.isArray(next)
    ? next.filter((m) => m && typeof m === 'object' && m.id !== undefined && m.id !== null)
    : []
  memosPubsub.emit(memos)
  return memos
}

export function addMemoTag(tag) {
  if (!tag || !tag.id) return false
  if (memoTags.find((t) => t.id === tag.id)) return false
  memoTags.push(tag)
  const ok = persistMemoTagsImpl()
  tagsPubsub.emit({ tags: memoTags, selectedId: selectedMemoTag })
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
  tagsPubsub.emit({ tags: memoTags, selectedId: selectedMemoTag })
  return ok
}

export function renameMemoTag(id, newName) {
  const tag = memoTags.find((t) => t.id === id)
  if (!tag || tag.isLocked) return false
  const next = (newName || '').trim()
  if (!next || next === tag.name) return false
  tag.name = next
  const ok = persistMemoTagsImpl()
  tagsPubsub.emit({ tags: memoTags, selectedId: selectedMemoTag })
  return ok
}

/**
 * 快速追加：若当日同 Tag 的卡片存在则追加到指定分类块；否则新建并置顶。
 * @returns {{ mode: 'append'|'create', memo: object, word: string, category: string } | null}
 */
export function appendOrDailyMemo(inputWord, currentTag, category = I18N.memo.defaultCategory) {
  const word = (inputWord || '').trim()
  if (!word) return null
  const tag = currentTag || selectedMemoTag
  // 分类取值优先级：调用方显式指定 > 生词本页面当前分类 > 默认"常规"。
  // 德语助手等其它模块不传 category（走默认参数）时，自动继承生词本页面当前的分类状态；
  // 分类输入框被清空（selectedMemoCategory 为空）时回落到默认"常规"。
  const explicitCat = String(category || '').trim()
  const cat = (explicitCat !== I18N.memo.defaultCategory ? explicitCat : selectedMemoCategory || explicitCat)
    .trim() || I18N.memo.defaultCategory

  const todayStr = getTodayDateString()
  const targetMemo = memos.find(
    (m) => m.tag === tag && String(m.timestamp || '').startsWith(todayStr)
  )

  let mode
  if (targetMemo) {
    const prevContent = targetMemo.content
    const prevTimestamp = targetMemo.timestamp
    targetMemo.content = appendToCategory(targetMemo.content, cat, word)
    targetMemo.timestamp = getFullTimestamp()
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
  if (!persisted) {
    // 持久化失败：回滚本次内存变更，避免"假成功"（数据写进内存却未落盘）。
    if (mode === 'create') {
      const removed = memos.findIndex((m) => m.id === memos[0].id)
      if (removed === 0) memos.shift()
    } else if (targetMemo) {
      targetMemo.content = prevContent
      targetMemo.timestamp = prevTimestamp
    }
    // 回滚 cleanExpiredMemosInPlace 可能删除的条目无法精确恢复，
    // 但过期清理属于幂等收敛，丢失可下次重建，故仅回滚本次主变更。
    DBG('memo:append:persist-fail', { mode })
    return null
  }
  memosPubsub.emit(memos)
  return { mode, memo: targetMemo || memos[0], word, category: cat }
}

export function addMemo(content, tag, category = I18N.memo.defaultCategory) {
  const cleaned = (content || '').trim()
  if (!cleaned) return null
  const useTag = tag || selectedMemoTag
  // 与 appendOrDailyMemo 保持一致：未显式指定分类时继承生词本页面当前分类。
  const explicitCat = String(category || '').trim()
  const cat = (explicitCat !== I18N.memo.defaultCategory ? explicitCat : selectedMemoCategory || explicitCat)
    .trim() || I18N.memo.defaultCategory
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
  if (!persisted) {
    // 持久化失败：回滚本次新建，避免内存态与落盘态不一致（"假成功"）。
    const idx = memos.findIndex((m) => m.id === memo.id)
    if (idx === 0) memos.shift()
    DBG('memo:add:persist-fail', { id: memo.id })
    return null
  }
  memosPubsub.emit(memos)
  return memo
}

export function deleteMemo(id) {
  const before = memos.length
  memos = memos.filter((m) => m.id !== id)
  if (memos.length === before) return false
  const ok = persistMemosImpl()
  memosPubsub.emit(memos)
  return ok
}

export function updateMemoContent(id, nextContent) {
  const memo = memos.find((m) => m.id === id)
  if (!memo) return false
  const prevContent = memo.content
  const prevTimestamp = memo.timestamp
  memo.content = (nextContent || '').replace(/\r\n/g, '\n')
  memo.timestamp = getFullTimestamp()
  const ok = persistMemosImpl()
  if (!ok) {
    // 持久化失败：回滚本次内容/时间戳变更，避免内存态与落盘态不一致。
    memo.content = prevContent
    memo.timestamp = prevTimestamp
    DBG('memo:update-content:persist-fail', { id })
    return ok
  }
  memosPubsub.emit(memos)
  return ok
}

export function updateMemoTag(id, nextTag) {
  const memo = memos.find((m) => m.id === id)
  if (!memo) return false
  memo.tag = nextTag
  const ok = persistMemosImpl()
  memosPubsub.emit(memos)
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
  return memosPubsub.on(fn)
}

export function onMemoTagsChange(fn) {
  return tagsPubsub.on(fn)
}

/**
 * german-store.js — 德语助手运行态（PubSub + 序号竞态防护）
 * -----------------------------------------------------------------------------
 * 职责：管理搜索候选词、详情加载状态、当前详情数据。
 * Store 只管状态，不操作 DOM；Renderer 只读快照；Events 只调方法。
 *
 * 竞态防护：detailSeq 递增序号。旧 LLM 请求返回时序号不匹配即丢弃，
 * 防止用户快速切换单词时旧结果覆盖新结果。
 */

import { createPubSub } from '../utils/pubsub.js'
import { DBG } from '../core/debug.js'

const pubsub = createPubSub()

let state = {
  query: '',              // 当前搜索输入
  suggestions: [],        // 本地匹配到的候选词列表
  detail: null,           // 当前展示的词条详情（来自缓存或 LLM）
  detailLoading: false,   // 详情是否正在加载（LLM 调用中）
  detailError: '',        // 详情加载失败时的可展示错误信息
  detailSeq: 0            // 递增序号，用于竞态校验
}

/**
 * 设置候选词列表（本地即时匹配，无需竞态校验）。
 */
export function setSuggestions(list) {
  const items = Array.isArray(list) ? list : []
  state = { ...state, suggestions: items, query: items.length ? state.query : '' }
  pubsub.emit(state)
  DBG('german:store:suggestions', { count: items.length })
}

/**
 * 清空候选词和搜索输入。
 */
export function resetInput() {
  state = { ...state, query: '', suggestions: [] }
  pubsub.emit(state)
}

/**
 * 开始一次详情查询，返回当前序号。
 * 后续 resolveLookup / failLookup 须传入同一序号做竞态校验。
 * @param {string} word — 要查询的单词
 * @returns {number} 本轮序号
 */
export function startLookup(word) {
  state.detailSeq += 1
  state = {
    ...state,
    detail: null,
    detailLoading: true,
    detailError: '',
    query: word
  }
  pubsub.emit(state)
  DBG('german:store:lookup-start', { word, seq: state.detailSeq })
  return state.detailSeq
}

/**
 * 详情查询成功（命中缓存或 LLM 返回）。
 * seq 与当前 detailSeq 不一致时静默丢弃（竞态防护）。
 * @returns {boolean} 是否成功落库
 */
export function resolveLookup(detail, seq) {
  if (typeof seq === 'number' && seq !== state.detailSeq) {
    DBG('german:store:lookup-stale', { seq, current: state.detailSeq })
    return false
  }
  state = {
    ...state,
    detail,
    detailLoading: false,
    detailError: ''
  }
  pubsub.emit(state)
  DBG('german:store:lookup-resolved', { word: detail?.word, definitions: detail?.definitions?.length || 0 })
  return true
}

/**
 * 详情查询失败。
 * seq 校验同 resolveLookup。
 */
export function failLookup(message, seq) {
  if (typeof seq === 'number' && seq !== state.detailSeq) return false
  state = {
    ...state,
    detail: null,
    detailLoading: false,
    detailError: message || '查询失败'
  }
  pubsub.emit(state)
  DBG('german:store:lookup-failed', { message })
  return true
}

/**
 * 获取当前状态快照（只读，Renderer 使用）。
 */
export function getGermanState() {
  return state
}

/**
 * 订阅状态变化（Renderer 注册回调）。
 * @returns {() => void} 取消订阅函数
 */
export function onGermanStateChange(fn) {
  return pubsub.on(fn)
}

/**
 * BaseStore 基类 - 统一存储操作模式
 * -----------------------------------------------------------------------------
 * 提供统一的存储操作接口，包括数据加载、持久化、订阅模式等。
 * 所有 Store 都继承此类，确保存储操作的一致性和安全性。
 * 采用渐进式优化，保持向后兼容性。
 */

import { DBG } from './debug.js'

/**
 * 基础 Store 类
 * @param {string} storageKey - LocalStorage 键名
 * @param {*} defaultValue - 默认值
 * @param {Function} normalizeFn - 数据标准化函数
 */
export class BaseStore {
  constructor(storageKey, defaultValue, normalizeFn = (x) => x) {
    if (typeof storageKey !== 'string' || !storageKey) {
      throw new Error('BaseStore: storageKey must be a non-empty string')
    }
    
    this.storageKey = storageKey
    this.defaultValue = defaultValue
    this.normalizeFn = normalizeFn
    this.state = null
    this.listeners = new Set()
    this.isLoading = false
    this.error = null
  }

  /**
   * 安全地加载数据
   * @returns {*} 加载的数据
   */
  load() {
    if (this.isLoading) {
      console.warn(`BaseStore: ${this.storageKey} is already loading`)
      return this.state
    }

    this.isLoading = true
    this.error = null

    try {
      const raw = localStorage.getItem(this.storageKey)
      if (raw === null) {
        this.state = this.defaultValue
        DBG('base-store:load:default', { key: this.storageKey })
      } else {
        const parsed = JSON.parse(raw)
        this.state = this.normalizeFn(parsed)
        DBG('base-store:load:success', { 
          key: this.storageKey, 
          type: typeof this.state,
          size: Array.isArray(this.state) ? this.state.length : 'N/A'
        })
      }
    } catch (error) {
      this.error = error
      console.error(`BaseStore: Failed to load ${this.storageKey}:`, error)
      this.state = this.defaultValue
      DBG('base-store:load:error', { 
        key: this.storageKey, 
        error: String(error) 
      })
    } finally {
      this.isLoading = false
    }

    return this.state
  }

  /**
   * 安全地持久化数据
   * @returns {boolean} 是否成功
   */
  persist() {
    if (this.isLoading) {
      console.warn(`BaseStore: ${this.storageKey} is loading, skipping persist`)
      return false
    }

    try {
      const serialized = JSON.stringify(this.state)
      localStorage.setItem(this.storageKey, serialized)
      DBG('base-store:persist:success', { 
        key: this.storageKey, 
        size: serialized.length 
      })
      return true
    } catch (error) {
      this.error = error
      console.error(`BaseStore: Failed to persist ${this.storageKey}:`, error)
      DBG('base-store:persist:error', { 
        key: this.storageKey, 
        error: String(error) 
      })
      return false
    }
  }

  /**
   * 获取当前状态
   * @returns {*} 当前状态
   */
  getState() {
    return this.state
  }

  /**
   * 更新状态
   * @param {*} newState - 新状态
   */
  updateState(newState) {
    const oldState = this.state
    this.state = newState
    this.notify()
    DBG('base-store:update', { 
      key: this.storageKey, 
      oldType: typeof oldState,
      newType: typeof newState 
    })
  }

  /**
   * 重置为默认值
   */
  reset() {
    this.state = this.defaultValue
    this.notify()
    DBG('base-store:reset', { key: this.storageKey })
  }

  /**
   * 订阅状态变化
   * @param {Function} listener - 监听函数
   * @returns {Function} 取消订阅函数
   */
  subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new Error('BaseStore: listener must be a function')
    }

    this.listeners.add(listener)
    
    // 立即通知一次当前状态
    try {
      listener(this.state)
    } catch (error) {
      console.error('BaseStore: Listener error:', error)
      this.listeners.delete(listener)
    }

    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * 通知所有监听器
   */
  notify() {
    this.listeners.forEach(listener => {
      try {
        listener(this.state)
      } catch (error) {
        console.error('BaseStore: Listener error:', error)
        this.listeners.delete(listener)
      }
    })
  }

  /**
   * 获取错误信息
   * @returns {Error|null} 错误信息
   */
  getError() {
    return this.error
  }

  /**
   * 清除错误信息
   */
  clearError() {
    this.error = null
  }

  /**
   * 销毁 Store，清理所有监听器
   */
  destroy() {
    this.listeners.clear()
    this.state = null
    this.error = null
  }
}

/**
 * 创建一个简单的 Store 工厂函数
 * @param {string} storageKey - LocalStorage 键名
 * @param {*} defaultValue - 默认值
 * @param {Function} normalizeFn - 数据标准化函数
 * @returns {BaseStore} Store 实例
 */
export function createStore(storageKey, defaultValue, normalizeFn) {
  return new BaseStore(storageKey, defaultValue, normalizeFn)
}

/**
 * 创建一个数组类型的 Store
 * @param {string} storageKey - LocalStorage 键名
 * @param {Array} defaultValue - 默认数组
 * @param {Function} normalizeFn - 数据标准化函数
 * @returns {BaseStore} Store 实例
 */
export function createArrayStore(storageKey, defaultValue = [], normalizeFn) {
  const normalize = (data) => {
    if (!Array.isArray(data)) return defaultValue
    return (normalizeFn || ((x) => x))(data)
  }
  return new BaseStore(storageKey, defaultValue, normalize)
}

/**
 * 创建一个对象类型的 Store
 * @param {string} storageKey - LocalStorage 键名
 * @param {Object} defaultValue - 默认对象
 * @param {Function} normalizeFn - 数据标准化函数
 * @returns {BaseStore} Store 实例
 */
export function createObjectStore(storageKey, defaultValue = {}, normalizeFn) {
  const normalize = (data) => {
    if (typeof data !== 'object' || data === null) return defaultValue
    return (normalizeFn || ((x) => x))(data)
  }
  return new BaseStore(storageKey, defaultValue, normalize)
}

export default BaseStore
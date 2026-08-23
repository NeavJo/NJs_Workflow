/**
 * NJsWorkflow · 增强存储工具
 * -----------------------------------------------------------------------------
 * 提供带错误处理、配额管理、数据验证和降级策略的存储工具。
 * 
 * 功能特性：
 * - 智能配额管理
 * - 数据验证和清理
 * - 自动降级策略
 * - 错误恢复机制
 * - 存储性能监控
 */

import { handleError, ErrorTypes, ErrorSeverity } from '../core/error-handler.js'

export class StorageUtils {
  constructor() {
    this.storagePrefix = 'njsw_'
    this.maxStorageSize = 5 * 1024 * 1024 // 5MB
    this.warningThreshold = 0.8 // 80% 警告阈值
    this.cleanupThreshold = 0.9 // 90% 清理阈值
    this.oldDataPrefix = 'old_'
    
    // 存储性能监控
    this.performanceMetrics = {
      operations: 0,
      errors: 0,
      totalSize: 0
    }
  }

  /**
   * 安全获取存储数据
   * @param {string} key - 存储键
   * @param {any} fallback - 默认值
   * @returns {any} 存储的数据
   */
  async safeGet(key, fallback = null) {
    try {
      // 检查存储配额
      if (await this.isStorageFull()) {
        await this.cleanupExpiredData()
        if (await this.isStorageFull()) {
          throw new Error('Storage quota exceeded after cleanup')
        }
      }

      const fullKey = this.getFullKey(key)
      const raw = localStorage.getItem(fullKey)
      
      if (raw === null) {
        return fallback
      }

      const parsed = JSON.parse(raw)
      
      // 数据验证
      if (!this.validateData(parsed)) {
        console.warn(`Invalid data format for key: ${key}`)
        return fallback
      }

      return parsed
    } catch (error) {
      handleError(error, {
        type: ErrorTypes.STORAGE,
        severity: ErrorSeverity.MEDIUM,
        context: { operation: 'get', key }
      })
      return fallback
    }
  }

  /**
   * 安全设置存储数据
   * @param {string} key - 存储键
   * @param {any} value - 要存储的数据
   * @returns {boolean} 是否成功
   */
  async safeSet(key, value) {
    try {
      // 数据验证
      if (!this.validateData(value)) {
        throw new Error('Invalid data format')
      }

      // 检查存储配额
      if (await this.isStorageFull()) {
        await this.cleanupExpiredData()
        if (await this.isStorageFull()) {
          throw new Error('Storage quota exceeded')
        }
      }

      const fullKey = this.getFullKey(key)
      const serialized = JSON.stringify(value)
      
      localStorage.setItem(fullKey, serialized)
      
      // 更新性能指标
      this.updatePerformanceMetrics('set', serialized.length)
      
      return true
    } catch (error) {
      handleError(error, {
        type: ErrorTypes.STORAGE,
        severity: ErrorSeverity.HIGH,
        context: { operation: 'set', key }
      })
      return false
    }
  }

  /**
   * 安全删除存储数据
   * @param {string} key - 存储键
   * @returns {boolean} 是否成功
   */
  async safeRemove(key) {
    try {
      const fullKey = this.getFullKey(key)
      localStorage.removeItem(fullKey)
      
      this.updatePerformanceMetrics('remove', 0)
      
      return true
    } catch (error) {
      handleError(error, {
        type: ErrorTypes.STORAGE,
        severity: ErrorSeverity.LOW,
        context: { operation: 'remove', key }
      })
      return false
    }
  }

  /**
   * 批量存储操作
   * @param {Array} operations - 操作数组
   * @returns {Object} 操作结果
   */
  async batchOperations(operations) {
    const results = []
    const errors = []

    for (const operation of operations) {
      try {
        let result
        
        switch (operation.type) {
          case 'set':
            result = await this.safeSet(operation.key, operation.value)
            break
          case 'get':
            result = await this.safeGet(operation.key, operation.fallback)
            break
          case 'remove':
            result = await this.safeRemove(operation.key)
            break
          default:
            throw new Error(`Unknown operation type: ${operation.type}`)
        }
        
        results.push({ ...operation, success: true, result })
      } catch (error) {
        results.push({ ...operation, success: false, error: error.message })
        errors.push(error)
      }
    }

    // 如果有错误，统一处理
    if (errors.length > 0) {
      handleError(new Error(`${errors.length} out of ${operations.length} operations failed`), {
        type: ErrorTypes.STORAGE,
        severity: ErrorSeverity.MEDIUM,
        context: { failedCount: errors.length, totalCount: operations.length }
      })
    }

    return { results, errors }
  }

  /**
   * 检查存储是否已满
   * @returns {boolean} 是否已满
   */
  async isStorageFull() {
    try {
      const usage = await this.getStorageUsage()
      return usage.percentage >= this.cleanupThreshold
    } catch (error) {
      handleError(error, {
        type: ErrorTypes.STORAGE,
        severity: ErrorSeverity.HIGH,
        context: { operation: 'check_quota' }
      })
      return true
    }
  }

  /**
   * 获取存储使用情况
   * @returns {Object} 存储使用情况
   */
  async getStorageUsage() {
    try {
      let totalSize = 0
      let usedKeys = 0
      
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith(this.storagePrefix)) {
          const value = localStorage.getItem(key)
          totalSize += (key.length + value?.length || 0) * 2 // UTF-16 编码
          usedKeys++
        }
      }

      const percentage = Math.min(totalSize / this.maxStorageSize, 1)
      
      return {
        totalSize,
        usedKeys,
        maxSize: this.maxStorageSize,
        percentage,
        isFull: percentage >= this.cleanupThreshold,
        isWarning: percentage >= this.warningThreshold
      }
    } catch (error) {
      handleError(error, {
        type: ErrorTypes.STORAGE,
        severity: ErrorSeverity.HIGH,
        context: { operation: 'get_usage' }
      })
      return {
        totalSize: 0,
        usedKeys: 0,
        maxSize: this.maxStorageSize,
        percentage: 1,
        isFull: true,
        isWarning: true
      }
    }
  }

  /**
   * 清理过期数据
   * @returns {number} 清理的项目数量
   */
  async cleanupExpiredData() {
    try {
      let cleanedCount = 0
      const now = Date.now()
      const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000 // 7天前

      const keysToRemove = []

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith(this.storagePrefix)) {
          try {
            const value = localStorage.getItem(key)
            const data = JSON.parse(value)
            
            // 检查是否过期
            if (data.timestamp && data.timestamp < oneWeekAgo) {
              keysToRemove.push(key)
            }
            
            // 检查是否是旧数据
            if (key.includes(this.oldDataPrefix)) {
              keysToRemove.push(key)
            }
          } catch (e) {
            // 如果数据解析失败，删除它
            keysToRemove.push(key)
          }
        }
      }

      // 删除过期数据
      keysToRemove.forEach(key => {
        localStorage.removeItem(key)
        cleanedCount++
      })

      if (cleanedCount > 0) {
        console.log(`Cleaned up ${cleanedCount} expired storage items`)
      }

      return cleanedCount
    } catch (error) {
      handleError(error, {
        type: ErrorTypes.STORAGE,
        severity: ErrorSeverity.MEDIUM,
        context: { operation: 'cleanup' }
      })
      return 0
    }
  }

  /**
   * 数据验证
   * @param {any} data - 要验证的数据
   * @returns {boolean} 是否有效
   */
  validateData(data) {
    // 检查是否为 null 或 undefined
    if (data === null || data === undefined) {
      return false
    }

    // 检查是否为循环引用
    try {
      JSON.stringify(data)
    } catch (e) {
      return false
    }

    // 检查数据大小
    const serialized = JSON.stringify(data)
    if (serialized.length > 1024 * 1024) { // 1MB 限制
      console.warn('Data too large, consider splitting into smaller chunks')
      return false
    }

    return true
  }

  /**
   * 获取完整的存储键
   * @param {string} key - 原始键
   * @returns {string} 完整的键
   */
  getFullKey(key) {
    return `${this.storagePrefix}${key}`
  }

  /**
   * 创建数据快照
   * @param {string} prefix - 键前缀
   * @returns {Object} 快照数据
   */
  createSnapshot(prefix = '') {
    try {
      const snapshot = {}
      const prefixToUse = prefix ? `${this.storagePrefix}${prefix}` : this.storagePrefix

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith(prefixToUse)) {
          try {
            const value = localStorage.getItem(key)
            snapshot[key] = JSON.parse(value)
          } catch (e) {
            snapshot[key] = value
          }
        }
      }

      return snapshot
    } catch (error) {
      handleError(error, {
        type: ErrorTypes.STORAGE,
        severity: ErrorSeverity.MEDIUM,
        context: { operation: 'create_snapshot', prefix }
      })
      return {}
    }
  }

  /**
   * 恢复数据快照
   * @param {Object} snapshot - 快照数据
   * @returns {boolean} 是否成功
   */
  restoreSnapshot(snapshot) {
    try {
      // 清理相关数据
      const prefix = this.storagePrefix
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key && key.startsWith(prefix)) {
          localStorage.removeItem(key)
        }
      }

      // 恢复数据
      for (const [key, value] of Object.entries(snapshot)) {
        localStorage.setItem(key, JSON.stringify(value))
      }

      return true
    } catch (error) {
      handleError(error, {
        type: ErrorTypes.STORAGE,
        severity: ErrorSeverity.HIGH,
        context: { operation: 'restore_snapshot' }
      })
      return false
    }
  }

  /**
   * 更新性能指标
   * @param {string} operation - 操作类型
   * @param {number} size - 数据大小
   */
  updatePerformanceMetrics(operation, size) {
    this.performanceMetrics.operations++
    this.performanceMetrics.totalSize += size

    if (operation === 'get' || operation === 'set') {
      this.performanceMetrics.errors++
    }
  }

  /**
   * 获取性能指标
   * @returns {Object} 性能指标
   */
  getPerformanceMetrics() {
    return { ...this.performanceMetrics }
  }

  /**
   * 清除性能指标
   */
  clearPerformanceMetrics() {
    this.performanceMetrics = {
      operations: 0,
      errors: 0,
      totalSize: 0
    }
  }

  /**
   * 导出存储数据
   * @returns {string} 导出的数据
   */
  exportData() {
    try {
      const data = this.createSnapshot()
      return JSON.stringify(data, null, 2)
    } catch (error) {
      handleError(error, {
        type: ErrorTypes.STORAGE,
        severity: ErrorSeverity.HIGH,
        context: { operation: 'export' }
      })
      return '{}'
    }
  }

  /**
   * 导入存储数据
   * @param {string} data - 导入的数据
   * @returns {boolean} 是否成功
   */
  importData(data) {
    try {
      const parsed = JSON.parse(data)
      return this.restoreSnapshot(parsed)
    } catch (error) {
      handleError(error, {
        type: ErrorTypes.STORAGE,
        severity: ErrorSeverity.HIGH,
        context: { operation: 'import' }
      })
      return false
    }
  }
}

// 创建全局存储工具实例
export const storageUtils = new StorageUtils()

// 导出便捷函数
export const safeGet = (key, fallback) => storageUtils.safeGet(key, fallback)
export const safeSet = (key, value) => storageUtils.safeSet(key, value)
export const safeRemove = (key) => storageUtils.safeRemove(key)
export const batchOperations = (operations) => storageUtils.batchOperations(operations)
export const getStorageUsage = () => storageUtils.getStorageUsage()
export const cleanupExpiredData = () => storageUtils.cleanupExpiredData()
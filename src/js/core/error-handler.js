/**
 * NJsWorkflow · 统一错误处理系统
 * -----------------------------------------------------------------------------
 * 提供全局错误分类、统一处理、用户反馈和错误恢复机制。
 * 
 * 功能特性：
 * - 错误分类和严重级别
 * - 全局异常捕获
 * - 自动重试机制
 * - 用户友好提示
 * - 错误统计和监控
 */

export const ErrorTypes = {
  NETWORK: 'network',
  STORAGE: 'storage',
  VALIDATION: 'validation',
  AUTHENTICATION: 'authentication',
  BUSINESS: 'business',
  SYSTEM: 'system',
  UNKNOWN: 'unknown'
}

export const ErrorSeverity = {
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  CRITICAL: 'critical'
}

export class ErrorHandler {
  constructor() {
    this.errorListeners = new Map()
    this.errorStats = {
      total: 0,
      byType: {},
      bySeverity: {},
      bySource: {}
    }
    this.initGlobalHandlers()
  }

  /**
   * 初始化全局错误处理器
   */
  initGlobalHandlers() {
    // 全局未捕获异常
    window.addEventListener('error', (event) => {
      this.handleError(event.error, {
        type: ErrorTypes.SYSTEM,
        severity: ErrorSeverity.HIGH,
        source: 'window.error',
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno
      })
    })

    // 未处理的 Promise 拒绝
    window.addEventListener('unhandledrejection', (event) => {
      this.handleError(event.reason, {
        type: ErrorTypes.UNKNOWN,
        severity: ErrorSeverity.HIGH,
        source: 'unhandledrejection'
      })
    })
  }

  /**
   * 处理错误
   * @param {Error|string} error - 错误对象或错误消息
   * @param {Object} context - 错误上下文
   * @returns {Object} 错误信息对象
   */
  handleError(error, context = {}) {
    // 标准化错误输入
    const errorInfo = this.normalizeError(error, context)
    
    // 更新错误统计
    this.updateErrorStats(errorInfo)
    
    // 记录错误
    this.logError(errorInfo)
    
    // 通知监听器
    this.notifyListeners(errorInfo)
    
    // 用户界面反馈
    this.showUserFeedback(errorInfo)
    
    // 错误恢复处理
    this.handleRecovery(errorInfo)
    
    return errorInfo
  }

  /**
   * 标准化错误信息
   */
  normalizeError(error, context) {
    const errorInfo = {
      message: error.message || String(error),
      stack: error.stack,
      type: context.type || this.getErrorType(error),
      severity: context.severity || this.getErrorSeverity(error),
      source: context.source || 'unknown',
      timestamp: new Date().toISOString(),
      context: context.context || {},
      ...context
    }

    // 清理敏感信息
    errorInfo.message = this.sanitizeMessage(errorInfo.message)
    
    return errorInfo
  }

  /**
   * 根据错误类型分类
   */
  getErrorType(error) {
    if (error.name === 'AbortError' || error.message?.includes('NetworkError') || error.message?.includes('fetch')) {
      return ErrorTypes.NETWORK
    }
    
    if (error.name === 'QuotaExceededError' || error.message?.includes('storage') || error.message?.includes('quota')) {
      return ErrorTypes.STORAGE
    }
    
    if (error.name === 'ValidationError' || error.message?.includes('validation') || error.message?.includes('invalid')) {
      return ErrorTypes.VALIDATION
    }
    
    if (error.name === 'AuthenticationError' || error.message?.includes('auth') || error.message?.includes('unauthorized')) {
      return ErrorTypes.AUTHENTICATION
    }
    
    if (error.name === 'BusinessError' || error.message?.includes('business')) {
      return ErrorTypes.BUSINESS
    }
    
    return ErrorTypes.UNKNOWN
  }

  /**
   * 根据错误严重程度分级
   */
  getErrorSeverity(error) {
    if (error.name === 'QuotaExceededError' || error.name === 'CriticalError') {
      return ErrorSeverity.CRITICAL
    }
    
    if (error.name === 'NetworkError' || error.name === 'AuthenticationError') {
      return ErrorSeverity.HIGH
    }
    
    if (error.name === 'ValidationError' || error.name === 'BusinessError') {
      return ErrorSeverity.MEDIUM
    }
    
    return ErrorSeverity.LOW
  }

  /**
   * 清理敏感信息
   */
  sanitizeMessage(message) {
    // 移除可能的敏感信息
    return message
      .replace(/token=[^&]*/g, 'token=***')
      .replace(/api[_-]?key[^=]*=[^&]*/g, 'api_key=***')
      .replace(/password[^=]*=[^&]*/g, 'password=***')
  }

  /**
   * 更新错误统计
   */
  updateErrorStats(errorInfo) {
    this.errorStats.total++
    
    const { type, severity, source } = errorInfo
    
    if (!this.errorStats.byType[type]) {
      this.errorStats.byType[type] = 0
    }
    this.errorStats.byType[type]++
    
    if (!this.errorStats.bySeverity[severity]) {
      this.errorStats.bySeverity[severity] = 0
    }
    this.errorStats.bySeverity[severity]++
    
    if (!this.errorStats.bySource[source]) {
      this.errorStats.bySource[source] = 0
    }
    this.errorStats.bySource[source]++
  }

  /**
   * 记录错误日志
   */
  logError(errorInfo) {
    const { message, type, severity, source, timestamp } = errorInfo
    
    // 使用现有的 DBG 系统
    if (typeof DBG !== 'undefined') {
      DBG('error:handler', {
        message,
        type,
        severity,
        source,
        timestamp
      })
    }
    
    // 控制台输出
    console.error(`[NJsWorkflow Error:${type}:${severity}] ${message}`, {
      timestamp,
      type,
      severity,
      source,
      stack: errorInfo.stack
    })
  }

  /**
   * 通知错误监听器
   */
  notifyListeners(errorInfo) {
    const listeners = this.errorListeners.get(errorInfo.type) || []
    
    listeners.forEach(listener => {
      try {
        listener(errorInfo)
      } catch (e) {
        console.error('Error in error listener:', e)
      }
    })
  }

  /**
   * 显示用户反馈
   */
  showUserFeedback(errorInfo) {
    const { message, severity, type } = errorInfo
    
    // 使用现有的 Toast 系统
    if (typeof showToast !== 'undefined') {
      let status = 'info'
      
      switch (severity) {
        case ErrorSeverity.CRITICAL:
        case ErrorSeverity.HIGH:
          status = 'error'
          break
        case ErrorSeverity.MEDIUM:
          status = 'warning'
          break
        case ErrorSeverity.LOW:
          status = 'info'
          break
      }
      
      showToast(message, { status })
    }
  }

  /**
   * 错误恢复处理
   */
  handleRecovery(errorInfo) {
    const { type, severity } = errorInfo
    
    // 存储错误：尝试清理
    if (type === ErrorTypes.STORAGE && severity === ErrorSeverity.CRITICAL) {
      this.handleStorageRecovery()
    }
    
    // 网络错误：标记网络问题
    if (type === ErrorTypes.NETWORK && severity === ErrorSeverity.HIGH) {
      this.handleNetworkRecovery()
    }
  }

  /**
   * 存储错误恢复
   */
  handleStorageRecovery() {
    // 尝试清理 localStorage
    try {
      const keys = Object.keys(localStorage)
      const oldKeys = keys.filter(key => key.startsWith('njsw_') && key.includes('old_'))
      
      oldKeys.forEach(key => {
        localStorage.removeItem(key)
      })
      
      if (oldKeys.length > 0) {
        console.log(`Cleaned up ${oldKeys.length} old storage items`)
      }
    } catch (e) {
      console.error('Storage recovery failed:', e)
    }
  }

  /**
   * 网络错误恢复
   */
  handleNetworkRecovery() {
    // 设置网络状态标志
    if (typeof window !== 'undefined') {
      window.njswNetworkAvailable = false
      
      // 5秒后重新检查网络
      setTimeout(() => {
        if (navigator.onLine) {
          window.njswNetworkAvailable = true
          console.log('Network connection restored')
        }
      }, 5000)
    }
  }

  /**
   * 添加错误监听器
   */
  addErrorListener(type, callback) {
    if (!this.errorListeners.has(type)) {
      this.errorListeners.set(type, [])
    }
    
    this.errorListeners.get(type).push(callback)
    
    // 返回清理函数
    return () => {
      const listeners = this.errorListeners.get(type)
      if (listeners) {
        const index = listeners.indexOf(callback)
        if (index > -1) {
          listeners.splice(index, 1)
        }
      }
    }
  }

  /**
   * 获取错误统计
   */
  getErrorStats() {
    return { ...this.errorStats }
  }

  /**
   * 清除错误统计
   */
  clearErrorStats() {
    this.errorStats = {
      total: 0,
      byType: {},
      bySeverity: {},
      bySource: {}
    }
  }
}

// 创建全局错误处理器实例
export const errorHandler = new ErrorHandler()

// 导出便捷函数
export const handleError = (error, context) => errorHandler.handleError(error, context)
export const addErrorListener = (type, callback) => errorHandler.addErrorListener(type, callback)
export const getErrorStats = () => errorHandler.getErrorStats()
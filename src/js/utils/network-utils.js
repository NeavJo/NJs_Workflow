/**
 * NJsWorkflow · 增强网络工具
 * -----------------------------------------------------------------------------
 * 提供带重试机制、错误处理和网络状态监控的网络请求工具。
 * 
 * 功能特性：
 * - 智能重试机制（指数退避）
 * - 网络状态监控
 * - 统一错误处理
 * - 请求超时控制
 * - 离线模式支持
 *
 * 接入范围说明（不重试决策）：
 * 本工具供“可安全重试”的 GET/幂等请求使用。当前 Gist 与 Anki 两条关键链路**故意不接入**：
 *  - Gist（backup/gist-sync.js 的 gistApiRequest）：写操作走 PATCH 覆盖写 + 冲突检测，
 *    自动重试可能在冲突被静默拉取后立即二次写同一份数据，产生多余 revision / 版本冲突；
 *    自动上传已有 debounce + 互斥 + skip-unchanged，失败一次不影响本地数据，下次编辑会重新触发。
 *  - Anki（anki/anki-api.js 的 fetchWithTimeout）：LLM 生成类请求响应慢（30s 超时基线），
 *    盲重试代价高且语义不幂等（会重复计费 / 重复生成），故保留“单次 + 超时 + 永不 reject”。
 * 详见各模块内的“网络重试决策”注释。
 */

import { handleError, ErrorTypes, ErrorSeverity } from '../core/error-handler.js'

export class NetworkUtils {
  constructor() {
    this.isNetworkAvailable = navigator.onLine
    this.pendingRequests = new Set()
    this.maxRetries = 3
    this.baseTimeout = 5000
    this.maxTimeout = 30000
    
    // 监听网络状态变化
    this.setupNetworkListeners()
  }

  /**
   * 设置网络状态监听器
   */
  setupNetworkListeners() {
    window.addEventListener('online', () => {
      this.isNetworkAvailable = true
      console.log('Network connection restored')
    })

    window.addEventListener('offline', () => {
      this.isNetworkAvailable = false
      console.log('Network connection lost')
    })
  }

  /**
   * 带重试机制的 fetch 请求
   * @param {string} url - 请求URL
   * @param {Object} options - 请求选项
   * @param {number} maxRetries - 最大重试次数
   * @returns {Promise} 请求结果
   */
  async fetchWithRetry(url, options = {}, maxRetries = this.maxRetries) {
    if (!this.isNetworkAvailable) {
      throw new Error('Network is currently offline')
    }

    let lastError
    const attemptOptions = { ...options }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 检查网络状态
        if (!this.isNetworkAvailable) {
          throw new Error('Network connection lost during request')
        }

        // 设置超时
        const timeout = attemptOptions.timeout || this.baseTimeout
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeout)
        
        // 添加请求到待处理集合
        const requestId = `${url}-${attempt}-${Date.now()}`
        this.pendingRequests.add(requestId)

        const response = await fetch(url, {
          ...attemptOptions,
          signal: controller.signal
        })

        clearTimeout(timer)
        this.pendingRequests.delete(requestId)

        // 处理响应
        if (!response.ok) {
          const error = new Error(`HTTP ${response.status}: ${response.statusText}`)
          error.status = response.status
          error.response = response
          
          // 对于特定状态码，不进行重试
          if ([401, 403, 404, 422].includes(response.status)) {
            throw error
          }
          
          throw error
        }

        return await response.json()
      } catch (error) {
        lastError = error
        
        // 如果是中止错误，直接抛出
        if (error.name === 'AbortError') {
          throw error
        }

        // 如果是最后一次尝试，跳出循环
        if (attempt === maxRetries) {
          break
        }

        // 指数退避重试
        const delay = Math.min(
          Math.pow(2, attempt) * 1000,
          this.maxTimeout
        )
        
        console.log(`Request failed, retrying in ${delay}ms...`, {
          url,
          attempt,
          error: error.message
        })

        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }

    // 所有重试都失败了，记录错误
    handleError(lastError, {
      type: ErrorTypes.NETWORK,
      severity: ErrorSeverity.HIGH,
      context: {
        url,
        maxRetries,
        attempt: maxRetries
      }
    })

    throw lastError
  }

  /**
   * 带缓存的 fetch 请求
   * @param {string} url - 请求URL
   * @param {Object} options - 请求选项
   * @param {Object} cacheOptions - 缓存选项
   * @returns {Promise} 请求结果
   */
  async fetchWithCache(url, options = {}, cacheOptions = {}) {
    const { 
      cacheKey = url,
      ttl = 300000, // 5分钟
      useCache = true 
    } = cacheOptions

    // 检查缓存
    if (useCache) {
      const cached = this.getFromCache(cacheKey)
      if (cached) {
        return cached
      }
    }

    // 发起请求
    const result = await this.fetchWithRetry(url, options)
    
    // 存储缓存
    if (useCache) {
      this.setCache(cacheKey, result, ttl)
    }

    return result
  }

  /**
   * 批量请求
   * @param {Array} requests - 请求配置数组
   * @param {Object} options - 批量请求选项
   * @returns {Promise} 批量请求结果
   */
  async batchRequests(requests, options = {}) {
    const { 
      batchSize = 5,
      delay = 100,
      failFast = false 
    } = options

    const results = []
    const errors = []

    for (let i = 0; i < requests.length; i += batchSize) {
      const batch = requests.slice(i, i + batchSize)
      
      const batchPromises = batch.map(async (request, index) => {
        try {
          const result = await this.fetchWithRetry(request.url, request.options)
          return { success: true, data: result, index: i + index }
        } catch (error) {
          if (failFast) {
            throw error
          }
          return { success: false, error, index: i + index }
        }
      })

      const batchResults = await Promise.all(batchPromises)
      results.push(...batchResults)

      // 批次间延迟
      if (i + batchSize < requests.length && delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }

    // 检查是否有错误
    const failedResults = results.filter(r => !r.success)
    if (failedResults.length > 0) {
      handleError(new Error(`${failedResults.length} out of ${requests.length} requests failed`), {
        type: ErrorTypes.NETWORK,
        severity: ErrorSeverity.MEDIUM,
        context: { failedCount: failedResults.length, totalCount: requests.length }
      })
    }

    return results
  }

  /**
   * 上传文件
   * @param {string} url - 上传URL
   * @param {File} file - 文件对象
   * @param {Object} options - 上传选项
   * @returns {Promise} 上传结果
   */
  async uploadFile(url, file, options = {}) {
    const { 
      onProgress,
      retries = this.maxRetries,
      ...fetchOptions 
    } = options

    // 创建 FormData
    const formData = new FormData()
    formData.append('file', file)

    // 监听上传进度
    if (onProgress && typeof XMLHttpRequest !== 'undefined') {
      return this.uploadFileWithXHR(url, formData, { onProgress, retries })
    }

    // 使用 fetch 上传
    return this.fetchWithRetry(url, {
      method: 'POST',
      body: formData,
      ...fetchOptions
    }, retries)
  }

  /**
   * 使用 XMLHttpRequest 上传文件（支持进度监听）
   */
  uploadFileWithXHR(url, formData, { onProgress, retries }) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && onProgress) {
          const progress = (event.loaded / event.total) * 100
          onProgress(progress)
        }
      })

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const response = JSON.parse(xhr.responseText)
            resolve(response)
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`))
          }
        } else {
          reject(new Error(`HTTP ${xhr.status}: ${xhr.statusText}`))
        }
      })

      xhr.addEventListener('error', () => {
        reject(new Error('Network error during file upload'))
      })

      // 重试逻辑
      const attemptUpload = (attempt) => {
        xhr.open('POST', url)
        xhr.send(formData)
      }

      attemptUpload(1)
    })
  }

  /**
   * 缓存操作
   */
  setCache(key, data, ttl) {
    try {
      const cacheData = {
        data,
        timestamp: Date.now(),
        ttl
      }
      localStorage.setItem(`njsw_cache_${key}`, JSON.stringify(cacheData))
    } catch (error) {
      handleError(error, {
        type: ErrorTypes.STORAGE,
        severity: ErrorSeverity.LOW,
        context: { operation: 'cache_set', key }
      })
    }
  }

  getFromCache(key) {
    try {
      const cached = localStorage.getItem(`njsw_cache_${key}`)
      if (!cached) return null

      const cacheData = JSON.parse(cached)
      const now = Date.now()
      
      if (now - cacheData.timestamp > cacheData.ttl) {
        localStorage.removeItem(`njsw_cache_${key}`)
        return null
      }

      return cacheData.data
    } catch (error) {
      handleError(error, {
        type: ErrorTypes.STORAGE,
        severity: ErrorSeverity.LOW,
        context: { operation: 'cache_get', key }
      })
      return null
    }
  }

  clearCache() {
    try {
      const keys = Object.keys(localStorage)
      const cacheKeys = keys.filter(key => key.startsWith('njsw_cache_'))
      
      cacheKeys.forEach(key => {
        localStorage.removeItem(key)
      })
      
      return cacheKeys.length
    } catch (error) {
      handleError(error, {
        type: ErrorTypes.STORAGE,
        severity: ErrorSeverity.MEDIUM,
        context: { operation: 'cache_clear' }
      })
      return 0
    }
  }

  /**
   * 取消所有待处理的请求
   */
  cancelAllRequests() {
    this.pendingRequests.clear()
  }

  /**
   * 获取网络状态
   */
  getNetworkStatus() {
    return {
      isOnline: this.isNetworkAvailable,
      pendingRequests: this.pendingRequests.size
    }
  }
}

// 创建全局网络工具实例
export const networkUtils = new NetworkUtils()

// 导出便捷函数
export const fetchWithRetry = (url, options, maxRetries) => networkUtils.fetchWithRetry(url, options, maxRetries)
export const fetchWithCache = (url, options, cacheOptions) => networkUtils.fetchWithCache(url, options, cacheOptions)
export const batchRequests = (requests, options) => networkUtils.batchRequests(requests, options)
export const uploadFile = (url, file, options) => networkUtils.uploadFile(url, file, options)
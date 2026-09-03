/**
 * DOM 工具类 - 统一DOM操作
 * -----------------------------------------------------------------------------
 * 提供统一的DOM元素选择、创建、更新、事件绑定等功能。
 * 减少重复代码，提升开发效率。
 * 采用渐进式优化，保持向后兼容性。
 */

/**
 * 裸 ID 判定：以字母开头，仅含字母 / 数字 / 连字符 / 下划线（无 CSS 特殊字符）。
 *
 * 匹配成功仅表示"可能是 ID"，会先尝试 getElementById；
 * 未命中则回退 querySelector，因此像 'div' / 'select' 这类合法标签选择器不受影响。
 */
const BARE_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/

/**
 * DOM 工具主对象
 */
const DOM = {
  /**
   * 元素选择器 - 单个元素
   *
   * 兼容两种写法：
   *  - 标准 CSS 选择器（'#id' / '.cls' / 'div > p'）
   *  - 裸 ID（'anki-api-type'），等价于 document.getElementById
   *
   * 裸 ID 形态（不含 CSS 特殊字符）会优先走 getElementById，
   * 未命中再回退到 querySelector，避免把标签选择器误判成 ID。
   *
   * @param {string} selector - CSS选择器或元素 ID
   * @param {Element} context - 上下文元素，默认为document
   * @returns {Element|null} 找到的元素
   */
  $(selector, context = document) {
    if (typeof selector !== 'string') {
      console.warn('DOM.$: selector must be a string')
      return null
    }
    if (BARE_ID_RE.test(selector)) {
      const root = context.nodeType === 9 ? context : context.ownerDocument || document
      const byId = root.getElementById(selector)
      if (byId) {
        if (context.nodeType === 9 || context.contains(byId)) return byId
      }
    }
    return context.querySelector(selector)
  },

  /**
   * 元素选择器 - 多个元素
   * @param {string} selector - CSS选择器
   * @param {Element} context - 上下文元素，默认为document
   * @returns {NodeList} 找到的元素列表
   */
  $$(selector, context = document) {
    if (typeof selector !== 'string') {
      console.warn('DOM.$$ : selector must be a string')
      return []
    }
    return context.querySelectorAll(selector)
  },

  /**
   * 创建元素
   * @param {string} tag - 标签名称
   * @param {Object} options - 配置选项
   * @returns {Element} 创建的元素
   */
  create(tag, options = {}) {
    if (typeof tag !== 'string') {
      throw new Error('DOM.create: tag must be a string')
    }

    const element = document.createElement(tag)
    
    // 处理类名
    if (options.className) {
      if (typeof options.className === 'string') {
        element.className = options.className
      } else if (Array.isArray(options.className)) {
        element.className = options.className.join(' ')
      }
    }

    // 处理属性
    if (options.attributes) {
      Object.entries(options.attributes).forEach(([key, value]) => {
        element.setAttribute(key, value)
      })
    }

    // 处理数据属性
    if (options.dataset) {
      Object.entries(options.dataset).forEach(([key, value]) => {
        element.dataset[key] = value
      })
    }

    // 处理样式
    if (options.style) {
      Object.entries(options.style).forEach(([key, value]) => {
        element.style[key] = value
      })
    }

    // 处理文本内容
    if (options.text !== undefined) {
      element.textContent = options.text
    }

    // 处理HTML内容
    if (options.html !== undefined) {
      element.innerHTML = options.html
    }

    // 处理子元素
    if (options.children) {
      if (Array.isArray(options.children)) {
        options.children.forEach(child => {
          if (child instanceof Node) {
            element.appendChild(child)
          }
        })
      } else if (options.children instanceof Node) {
        element.appendChild(options.children)
      }
    }

    return element
  },

  /**
   * 更新元素
   * @param {Element} element - 要更新的元素
   * @param {Object} updates - 更新内容
   */
  update(element, updates = {}) {
    if (!element || !(element instanceof Element)) {
      console.warn('DOM.update: element must be a valid Element')
      return
    }

    // 更新类名
    if (updates.className !== undefined) {
      if (typeof updates.className === 'string') {
        element.className = updates.className
      } else if (Array.isArray(updates.className)) {
        element.className = updates.className.join(' ')
      }
    }

    // 更新属性
    if (updates.attributes !== undefined) {
      Object.entries(updates.attributes).forEach(([key, value]) => {
        if (value === null || value === undefined) {
          element.removeAttribute(key)
        } else {
          element.setAttribute(key, value)
        }
      })
    }

    // 更新数据属性
    if (updates.dataset !== undefined) {
      Object.entries(updates.dataset).forEach(([key, value]) => {
        element.dataset[key] = value
      })
    }

    // 更新样式
    if (updates.style !== undefined) {
      Object.entries(updates.style).forEach(([key, value]) => {
        if (value === null || value === undefined) {
          element.style.removeProperty(key)
        } else {
          element.style[key] = value
        }
      })
    }

    // 更新文本内容
    if (updates.text !== undefined) {
      element.textContent = updates.text
    }

    // 更新HTML内容
    if (updates.html !== undefined) {
      element.innerHTML = updates.html
    }
  },

  /**
   * 批量创建和更新元素
   * @param {Array} operations - 操作数组
   * @returns {Array} 创建的元素数组
   */
  batch(operations) {
    if (!Array.isArray(operations)) {
      throw new Error('DOM.batch: operations must be an array')
    }

    const results = []
    
    operations.forEach(op => {
      try {
        if (op.type === 'create') {
          const element = this.create(op.tag, op.options)
          results.push(element)
        } else if (op.type === 'update') {
          this.update(op.element, op.updates)
          results.push(op.element)
        } else if (op.type === 'append') {
          op.parent.appendChild(op.element)
          results.push(op.element)
        } else if (op.type === 'prepend') {
          op.parent.insertBefore(op.element, op.parent.firstChild)
          results.push(op.element)
        } else if (op.type === 'remove') {
          if (op.element.parentNode) {
            op.element.parentNode.removeChild(op.element)
          }
          results.push(null)
        }
      } catch (error) {
        console.error('DOM.batch: Operation failed:', op, error)
        results.push(null)
      }
    })

    return results
  },

  /**
   * 绑定事件
   * @param {Element} element - 元素
   * @param {string} event - 事件名称
   * @param {Function} handler - 处理函数
   * @param {Object} options - 选项
   * @returns {Function} 清理函数
   */
  on(element, event, handler, options = {}) {
    if (!element || typeof element.addEventListener !== 'function') {
      console.warn('DOM.on: element must be a valid DOM element')
      return () => {}
    }

    if (typeof handler !== 'function') {
      console.warn('DOM.on: handler must be a function')
      return () => {}
    }

    element.addEventListener(event, handler, options)
    
    return () => {
      element.removeEventListener(event, handler, options)
    }
  },

  /**
   * 绑定一次性事件
   * @param {Element} element - 元素
   * @param {string} event - 事件名称
   * @param {Function} handler - 处理函数
   * @param {Object} options - 选项
   * @returns {Function} 清理函数
   */
  once(element, event, handler, options = {}) {
    const wrappedHandler = (...args) => {
      handler(...args)
      this.off(element, event, wrappedHandler)
    }
    return this.on(element, event, wrappedHandler, options)
  },

  /**
   * 移除事件
   * @param {Element} element - 元素
   * @param {string} event - 事件名称
   * @param {Function} handler - 处理函数
   */
  off(element, event, handler) {
    if (!element || typeof element.removeEventListener !== 'function') {
      return
    }
    element.removeEventListener(event, handler)
  },

  /**
   * 批量绑定事件
   * @param {Element} element - 元素
   * @param {Array} events - 事件数组
   * @returns {Array} 清理函数数组
   */
  onBatch(element, events) {
    if (!Array.isArray(events)) {
      throw new Error('DOM.onBatch: events must be an array')
    }

    const cleanups = []
    
    events.forEach(({ event, handler, options }) => {
      const cleanup = this.on(element, event, handler, options)
      cleanups.push(cleanup)
    })

    return () => cleanups.forEach(cleanup => cleanup())
  },

  /**
   * 显示元素
   * @param {Element} element - 元素
   * @param {string} display - display值，默认为'block'
   */
  show(element, display = 'block') {
    if (element) {
      element.style.display = display
    }
  },

  /**
   * 隐藏元素
   * @param {Element} element - 元素
   */
  hide(element) {
    if (element) {
      element.style.display = 'none'
    }
  },

  /**
   * 切换元素显示状态
   * @param {Element} element - 元素
   * @param {string} display - display值，默认为'block'
   */
  toggle(element, display = 'block') {
    if (element) {
      element.style.display = element.style.display === 'none' ? display : 'none'
    }
  },

  /**
   * 添加类名
   * @param {Element} element - 元素
   * @param {string|Array} className - 类名
   */
  addClass(element, className) {
    if (!element) return
    if (Array.isArray(className)) {
      element.classList.add(...className)
    } else {
      element.classList.add(className)
    }
  },

  /**
   * 移除类名
   * @param {Element} element - 元素
   * @param {string|Array} className - 类名
   */
  removeClass(element, className) {
    if (!element) return
    if (Array.isArray(className)) {
      element.classList.remove(...className)
    } else {
      element.classList.remove(className)
    }
  },

  /**
   * 切换类名
   * @param {Element} element - 元素
   * @param {string} className - 类名
   * @param {boolean} force - 强制添加或移除
   */
  toggleClass(element, className, force) {
    if (!element) return
    element.classList.toggle(className, force)
  },

  /**
   * 检查是否包含类名
   * @param {Element} element - 元素
   * @param {string} className - 类名
   * @returns {boolean} 是否包含
   */
  hasClass(element, className) {
    return element ? element.classList.contains(className) : false
  },

  /**
   * 设置元素属性
   * @param {Element} element - 元素
   * @param {string} key - 属性名
   * @param {*} value - 属性值
   */
  setAttr(element, key, value) {
    if (element) {
      element.setAttribute(key, value)
    }
  },

  /**
   * 获取元素属性
   * @param {Element} element - 元素
   * @param {string} key - 属性名
   * @returns {*} 属性值
   */
  getAttr(element, key) {
    return element ? element.getAttribute(key) : null
  },

  /**
   * 移除元素属性
   * @param {Element} element - 元素
   * @param {string} key - 属性名
   */
  removeAttr(element, key) {
    if (element) {
      element.removeAttribute(key)
    }
  },

  /**
   * 清空元素内容
   * @param {Element} element - 元素
   */
  empty(element) {
    if (element) {
      element.innerHTML = ''
    }
  },

  /**
   * 移除元素
   * @param {Element} element - 元素
   */
  remove(element) {
    if (element && element.parentNode) {
      element.parentNode.removeChild(element)
    }
  },

  /**
   * 插入元素
   * @param {Element} element - 要插入的元素
   * @param {Element} parent - 父元素
   * @param {Element} reference - 参考元素，默认为null
   */
  insert(element, parent, reference = null) {
    if (element && parent) {
      parent.insertBefore(element, reference)
    }
  },

  /**
   * 克隆元素
   * @param {Element} element - 要克隆的元素
   * @param {boolean} deep - 是否深度克隆
   * @returns {Element} 克隆的元素
   */
  clone(element, deep = true) {
    return element ? element.cloneNode(deep) : null
  },

  /**
   * 查找最近的匹配选择器的祖先元素
   * @param {Element} element - 起始元素
   * @param {string} selector - 选择器
   * @returns {Element|null} 找到的元素
   */
  closest(element, selector) {
    return element ? element.closest(selector) : null
  },

  /**
   * 查找所有匹配选择器的子元素
   * @param {Element} element - 父元素
   * @param {string} selector - 选择器
   * @returns {Array} 匹配的元素数组
   */
  children(element, selector = null) {
    if (!element) return []
    if (selector) {
      return Array.from(element.querySelectorAll(selector))
    }
    return Array.from(element.children)
  },

  /**
   * 获取元素尺寸和位置信息
   * @param {Element} element - 元素
   * @returns {DOMRect} 尺寸和位置信息
   */
  getRect(element) {
    return element ? element.getBoundingClientRect() : null
  },

  /**
   * 检查元素是否在视口中
   * @param {Element} element - 元素
   * @param {Object} options - 选项
   * @returns {boolean} 是否在视口中
   */
  isInViewport(element, options = {}) {
    if (!element) return false
    
    const rect = this.getRect(element)
    const { threshold = 0 } = options
    
    return (
      rect.top <= (window.innerHeight || document.documentElement.clientHeight) * (1 + threshold) &&
      rect.left <= (window.innerWidth || document.documentElement.clientWidth) * (1 + threshold) &&
      rect.bottom >= 0 * (1 - threshold) &&
      rect.right >= 0 * (1 - threshold)
    )
  },

  /**
   * 滚动到元素
   * @param {Element} element - 元素
   * @param {Object} options - 滚动选项
   */
  scrollTo(element, options = {}) {
    if (element) {
      element.scrollIntoView(options)
    }
  },

  /**
   * 获取或设置元素文本内容
   * @param {Element} element - 元素
   * @param {string} text - 文本内容（可选）
   * @returns {string} 文本内容
   */
  text(element, text) {
    if (!element) return ''
    if (text !== undefined) {
      element.textContent = text
    }
    return element.textContent
  },

  /**
   * 获取或设置元素HTML内容
   * @param {Element} element - 元素
   * @param {string} html - HTML内容（可选）
   * @returns {string} HTML内容
   */
  html(element, html) {
    if (!element) return ''
    if (html !== undefined) {
      element.innerHTML = html
    }
    return element.innerHTML
  }
}

// 导出DOM工具
export default DOM

// 导出便捷函数
export function $(selector, context) {
  return DOM.$(selector, context)
}

export function $$(selector, context) {
  return DOM.$$(selector, context)
}

export function create(tag, options) {
  return DOM.create(tag, options)
}

export function on(element, event, handler, options) {
  return DOM.on(element, event, handler, options)
}

export function off(element, event, handler) {
  DOM.off(element, event, handler)
}

export function addClass(element, className) {
  DOM.addClass(element, className)
}

export function removeClass(element, className) {
  DOM.removeClass(element, className)
}

export function toggleClass(element, className, force) {
  DOM.toggleClass(element, className, force)
}

export function hasClass(element, className) {
  return DOM.hasClass(element, className)
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]))
}

/**
 * 一次性事件监听器：触发后自动移除。
 * 比 bindOnce 轻量，不依赖全局 EventManager，适合独立组件使用。
 */
export function once(element, event, handler, options) {
  const wrapped = (...args) => {
    handler(...args)
    element.removeEventListener(event, wrapped, options)
  }
  element.addEventListener(event, wrapped, options)
  return wrapped
}
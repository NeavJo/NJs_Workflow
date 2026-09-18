/**
 * 幂等守卫助手 - 统一"防重复绑定"标记
 * -----------------------------------------------------------------------------
 * 背景：本仓库多处需要"只绑定一次，再次调用直接返回"的幂等守卫。
 * 早期写法 `element.dataset.bound = '1'` 在普通 DOM 元素上没问题，
 * 但有一处误把宿主对象写成了全局的 `document.dataset`：
 *   - `document.dataset` 只有在 body 解析完成、Document 进入"complete"
 *     解析状态后才会存在；若模块在 body 解析前被加载（异常时序 /
 *     CDP headless / 测试环境），它会 undefined，直接抛 TypeError，
 *     从而中断外层 try/catch 内的后续绑定 → 多个功能一起瘫痪。
 *
 * 规则（今后任何 P 级优化必须遵守）：
 *   1. 任何"防重复绑定/防重复初始化"的幂等守卫，一律走本模块提供的
 *      `isGuarded(el, key)` / `markGuarded(el, key)` 或 `createGuard(key)`，
 *      禁止再写 `el.dataset.xxx = '1'` 或 `document.dataset.xxx`。
 *   2. 本模块只用模块级 `Map`（弱引用语义由 JS 引擎在卸载时清理，
 *      且标记只存于 Map、不污染 DOM），不依赖 DOM 的 dataset 字段。
 *   3. 宿主对象可以是 `HTMLElement` / `SVGElement` / `document`，
 *      本助手用 `Object` 引用做 Map key（同一对象引用永远命中同一标记）。
 *
 * 设计要点：
 *   - `Map<object, Set<string>>`：对象 → 该对象上已打的标记集合。
 *   - 不暴露内部 Map，外部只能通过 `isGuarded` / `markGuarded` 访问，
 *     避免守卫散落在多个文件里各自一份。
 *   - `createGuard(key)` 返回一个绑定到某 key 的 guard 对象（语法糖，
 *     方便调用点写 `if (guard.is()) return; guard.set()`）。
 */

/** @type {Map<object, Set<string>>} */
const guardMap = new Map()

/**
 * 判断宿主对象上某个 key 的守卫是否已置位。
 * @param {object} host - 宿主对象（Element / document / 任意对象引用）
 * @param {string} key - 守卫 key（建议语义化命名，如 'modalEventsBound'）
 * @returns {boolean}
 */
export function isGuarded(host, key) {
  if (!host || typeof key !== 'string') return false
  const set = guardMap.get(host)
  if (!set) return false
  return set.has(key)
}

/**
 * 把宿主对象上某个 key 的守卫置位。
 * @param {object} host - 宿主对象
 * @param {string} key - 守卫 key
 */
export function markGuarded(host, key) {
  if (!host || typeof key !== 'string') return
  let set = guardMap.get(host)
  if (!set) {
    set = new Set()
    guardMap.set(host, set)
  }
  set.add(key)
}

/**
 * 创建绑定到指定 key 的 guard 句柄（语法糖）。
 * 用法：
 *   const modalGuard = createGuard('modalEventsBound')
 *   if (modalGuard.is(document)) return
 *   modalGuard.set(document)
 * @param {string} key - 守卫 key
 * @returns {{is:(host?:object)=>boolean, set:(host?:object)=>void}}
 */
export function createGuard(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`createGuard: key 必须是非空字符串，实际收到 ${key}`)
  }
  return {
    is: (host) => isGuarded(host || document, key),
    set: (host) => markGuarded(host || document, key)
  }
}

/**
 * 审计用：返回当前所有已置位的守卫（仅调试 / CI 自检使用，
 * 不要在生产路径里遍历，会影响性能）。
 * @returns {Array<{host: string, keys: string[]}>}
 */
export function listActiveGuards() {
  const out = []
  for (const [host, keys] of guardMap.entries()) {
    let label
    if (typeof host === 'string') {
      label = `[string:${host}]`
    } else if (host && host.nodeType === 9) {
      label = '[Document]'
    } else if (host && host.nodeType === 1) {
      label = `<${host.tagName || 'unknown'}${host.id ? '#' + host.id : ''}>`
    } else if (host && host.constructor && host.constructor.name) {
      label = `[${host.constructor.name}]`
    } else {
      label = '[unknown]'
    }
    out.push({ host: label, keys: [...keys] })
  }
  return out
}

export default { isGuarded, markGuarded, createGuard, listActiveGuards }

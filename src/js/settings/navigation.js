/**
 * 视图 / 设置页导航：
 *  - switchView：切换主功能页（flow / memo / settings）
 *  - switchSettingsView：设置页内子视图切换（main / backup / workflow / tags）
 *  - registerViewHook：注册顶级视图进入时的回调（解耦导航与领域渲染）
 *
 * 设置页自 v2 起不再是 modal，而是顶级 .view[data-view="settings"]，
 * 因此子视图查询范围由原来的 #settings-modal 改为新的设置根节点。
 */

export const TOP_LEVEL_VIEWS = ['flow', 'memo', 'anki', 'monthly', 'german', 'settings']
export const SETTINGS_VIEWS = ['main', 'backup', 'anki-api', 'workflow', 'tags', 'german']

let currentView = 'flow'
let currentSettingsView = 'main'
let settingsTransitionId = 0
const viewHooks = new Map()
let viewTransitionId = 0

function getViewTransitionDuration(baseDuration) {
  const scale = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--view-transition-speed-scale')
  )
  return baseDuration * (Number.isFinite(scale) && scale > 0 ? scale : 1)
}

function getSettingsRoot() {
  return document.querySelector('.view--settings[data-view="settings"]')
}

export function registerViewHook(viewName, callback) {
  if (!TOP_LEVEL_VIEWS.includes(viewName)) return
  if (typeof callback !== 'function') return
  viewHooks.set(viewName, callback)
}

export function getCurrentView() {
  return currentView
}

export function getCurrentSettingsView() {
  return currentSettingsView
}

export function switchView(target) {
  if (!TOP_LEVEL_VIEWS.includes(target)) return false

  const targetView = document.querySelector(`.view[data-view="${target}"]`)
  const targetNav = document.querySelector(`.nav-item[data-view="${target}"]`)
  if (!targetView || !targetNav) return false

  const previousView = currentView
  if (previousView === target) return true
  currentView = target
  const transitionId = ++viewTransitionId
  const mainContent = document.querySelector('.main-content')
  const direction = TOP_LEVEL_VIEWS.indexOf(target) > TOP_LEVEL_VIEWS.indexOf(previousView) ? 'forward' : 'back'

  document.querySelectorAll('.nav-item').forEach((item) => {
    const active = item.dataset.view === target
    item.classList.toggle('is-active', active)
    if (active) {
      item.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' })
    }
  })

  window.scrollTo({ top: 0, behavior: 'smooth' })

  const visibleViews = Array.from(document.querySelectorAll('.view')).filter((view) => !view.hidden)
  const previousTarget =
    document.querySelector('.view.is-view-active:not([hidden])') ||
    visibleViews.find((view) => view !== targetView) ||
    null
  const finishTransition = () => {
    if (transitionId !== viewTransitionId) return
    document.querySelectorAll('.view').forEach((view) => {
      if (view === targetView) return
      view.hidden = true
      view.classList.remove('is-view-active', 'is-view-entering', 'is-view-entering-forward', 'is-view-entering-back', 'is-view-leaving', 'is-view-leaving-forward', 'is-view-leaving-back')
    })
    mainContent?.classList.remove('is-view-transitioning')
  }

  document.querySelectorAll('.view').forEach((view) => {
    view.classList.remove(
      'is-view-active', 'is-view-entering', 'is-view-entering-forward', 'is-view-entering-back',
      'is-view-leaving', 'is-view-leaving-forward', 'is-view-leaving-back'
    )
    if (view !== targetView && view !== previousTarget) view.hidden = true
  })

  targetView.hidden = false
  previousTarget?.classList.add('is-view-leaving', `is-view-leaving-${direction}`)
  targetView.classList.add('is-view-entering', `is-view-entering-${direction}`)
  mainContent?.classList.add('is-view-transitioning')
  const startTargetEnter = () => {
    if (transitionId !== viewTransitionId) return
    targetView.offsetWidth
    requestAnimationFrame(() => {
      if (transitionId !== viewTransitionId) return
      targetView.classList.remove('is-view-entering', 'is-view-entering-forward', 'is-view-entering-back')
      targetView.classList.add('is-view-active')
    })
  }
  if (previousTarget) {
    window.setTimeout(() => {
      finishTransition()
      startTargetEnter()
    }, getViewTransitionDuration(360))
  } else {
    startTargetEnter()
  }

  const hook = viewHooks.get(target)
  if (hook) {
    try {
      hook({
        previousView,
        isFirstEntry: previousView !== target
      })
    } catch (e) {
      /* noop */
    }
  }

  return true
}

export function switchSettingsView(target, { skipIntro = false } = {}) {
  const root = getSettingsRoot()
  if (!root) return false

  const views = Array.from(root.querySelectorAll('[data-settings-view]'))
  const targetView = views.find((v) => v.dataset.settingsView === target)
  if (!targetView) return false

  const current = views.find((v) => v.classList.contains('is-active'))
  if (current === targetView) return true

  const goingForward = current && current.dataset.settingsView === 'main' && target !== 'main'
  const goingBack    = current && current.dataset.settingsView !== 'main' && target === 'main'

  if (skipIntro) {
    settingsTransitionId += 1
    targetView.hidden = false
    targetView.classList.remove(
      'is-entering-forward', 'is-entering-back',
      'is-leaving', 'is-leaving-forward', 'is-leaving-back'
    )
    targetView.classList.add('is-active')
    views.forEach((view) => {
      if (view === targetView) return
      view.hidden = true
      view.classList.remove(
        'is-active', 'is-entering-forward', 'is-entering-back',
        'is-leaving', 'is-leaving-forward', 'is-leaving-back'
      )
    })
    currentSettingsView = target
    return true
  }

  const transitionId = ++settingsTransitionId

  targetView.hidden = false
  targetView.classList.remove(
    'is-active', 'is-leaving', 'is-leaving-forward', 'is-leaving-back',
    'is-entering-forward', 'is-entering-back'
  )

  if (current) {
    current.classList.remove('is-active', 'is-entering-forward', 'is-entering-back')
    current.classList.add(goingForward ? 'is-leaving-back' : 'is-leaving-forward')

    const finalize = () => {
      if (transitionId !== settingsTransitionId) return
      current.hidden = true
      current.classList.remove('is-leaving-forward', 'is-leaving-back')

      targetView.classList.add(goingBack ? 'is-entering-back' : 'is-entering-forward')
      requestAnimationFrame(() => {
        targetView.classList.remove('is-entering-forward', 'is-entering-back')
        targetView.classList.add('is-active')
      })
    }
    window.setTimeout(finalize, getViewTransitionDuration(280))
  } else {
    targetView.classList.add(goingBack ? 'is-entering-back' : 'is-entering-forward')
    requestAnimationFrame(() => {
      targetView.classList.remove('is-entering-forward', 'is-entering-back')
      targetView.classList.add('is-active')
    })
  }

  currentSettingsView = target
  return true
}

export function bindNavigationEvents() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    // 幂等守卫：防止重复绑定 nav-item click 监听（如多次进入设置页 / 多次调用本函数）
    if (item.dataset.bound === '1') return
    item.dataset.bound = '1'
    item.addEventListener('click', () => switchView(item.dataset.view))
  })
}

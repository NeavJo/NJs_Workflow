import { DBG } from '../core/debug.js'
import { showToast } from '../ui.js'
import { I18N, t } from '../locales.js'
import { getWorkflows } from './workflow-store.js'
import { getCompletedIds, persistCompleted, hasCompleted, toggleCompleted } from './completion-store.js'
import { renderWorkflow } from './workflow-renderer.js'
import { runMemoCountCheck, checkPrerequisites } from './workflow-runtime.js'
import { isTaskSnoozed } from './snooze-store.js'
import { getUserSettings } from '../core/settings-store.js'
import { bindBatch } from '../utils/event-manager.js'
import { throttle } from '../utils/throttle.js'

/**
 * 工作流事件层：把 DOM 事件桥接到 store 写入 + 渲染。
 * 不持有任何状态，事件回调通过依赖的 store 拿到最新值。
 */

function createFairyParticle(pointerX, pointerY, cardRect, driftSpeed) {
  const particle = document.createElement('i')
  const angle = Math.random() * Math.PI * 2
  const radius = 8 + Math.random() * 72
  const x = Math.min(cardRect.width, Math.max(0, pointerX + Math.cos(angle) * radius))
  const y = Math.min(cardRect.height, Math.max(0, pointerY + Math.sin(angle) * radius))
  particle.className = 'workflow-card__particle'
  particle.style.setProperty('--particle-x', `${x}px`)
  particle.style.setProperty('--particle-y', `${y}px`)
  particle.style.setProperty('--particle-drift-x', `${(Math.random() - 0.5) * 34}px`)
  particle.style.setProperty('--particle-drift-y', `${(Math.random() - 0.5) * 34}px`)
  particle.style.setProperty('--particle-drift-2-x', `${(Math.random() - 0.5) * 28}px`)
  particle.style.setProperty('--particle-drift-2-y', `${(Math.random() - 0.5) * 28}px`)
  particle.style.setProperty('--particle-size', `${1 + Math.random() * 1.2}px`)
  particle.style.setProperty('--particle-duration', `${(5.5 + Math.random() * 4) / driftSpeed}s`)
  particle.style.setProperty('--particle-delay', `${Math.random() * -9.5}s`)
  particle.style.setProperty('--particle-opacity', `${0.42 + Math.random() * 0.38}`)
  return particle
}

function createFairyParticles(layer, cardRect, pointerX, pointerY) {
  const fragment = document.createDocumentFragment()
  const driftSpeed = Math.min(2, Math.max(0.25, Number(getUserSettings().workflowFairyDriftSpeed) || 1))
  const simulation = {
    pointer: { x: pointerX, y: pointerY },
    smooth: { x: pointerX, y: pointerY },
    velocity: { x: 0, y: 0 },
    origin: { x: pointerX, y: pointerY },
    raf: 0,
    lastTime: 0,
    active: true,
    card: layer.closest('.workflow-card')
  }
  for (let index = 0; index < 110; index += 1) {
    fragment.append(createFairyParticle(pointerX, pointerY, cardRect, driftSpeed))
  }
  layer.replaceChildren(fragment)
  layer.style.transform = 'translate3d(0, 0, 0)'
  layer.workflowFairySimulation = simulation
}

function updateFairyParticles(layer, cardRect, pointerX, pointerY) {
  let simulation = layer.workflowFairySimulation
  if (!simulation) {
    createFairyParticles(layer, cardRect, pointerX, pointerY)
    simulation = layer.workflowFairySimulation
  }
  simulation.pointer.x = pointerX
  simulation.pointer.y = pointerY
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches && !simulation.raf) {
    simulation.raf = requestAnimationFrame((time) => stepFairyParticles(simulation, layer, time))
  } else if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    simulation.smooth.x = pointerX
    simulation.smooth.y = pointerY
    layer.style.transform = `translate3d(${pointerX - simulation.origin.x}px, ${pointerY - simulation.origin.y}px, 0)`
  }
}

function stepFairyParticles(simulation, layer, now) {
  simulation.raf = 0
  // 高级视觉关闭时立即终止跟随循环并清理粒子，确保关闭状态没有持续渲染开销。
  if (
    !simulation.active ||
    !simulation.card?.isConnected ||
    !document.body.classList.contains('is-advanced-visual')
  ) {
    stopFairyParticles(simulation)
    return
  }
  const previous = simulation.lastTime || now
  simulation.lastTime = now
  const dt = Math.min(64, now - previous) / 1000
  const stiffness = 30
  const damping = 2 * Math.sqrt(stiffness) * 0.82
  const dx = simulation.pointer.x - simulation.smooth.x
  const dy = simulation.pointer.y - simulation.smooth.y
  simulation.velocity.x += (stiffness * dx - damping * simulation.velocity.x) * dt
  simulation.velocity.y += (stiffness * dy - damping * simulation.velocity.y) * dt
  simulation.smooth.x += simulation.velocity.x * dt
  simulation.smooth.y += simulation.velocity.y * dt
  const x = simulation.smooth.x - simulation.origin.x
  const y = simulation.smooth.y - simulation.origin.y
  layer.style.transform = `translate3d(${x}px, ${y}px, 0)`
  if (Math.hypot(dx, dy) > 0.08 || Math.hypot(simulation.velocity.x, simulation.velocity.y) > 0.12) {
    simulation.raf = requestAnimationFrame((time) => stepFairyParticles(simulation, layer, time))
  } else {
    simulation.smooth.x = simulation.pointer.x
    simulation.smooth.y = simulation.pointer.y
    simulation.velocity.x = 0
    simulation.velocity.y = 0
    layer.style.transform = `translate3d(${simulation.pointer.x - simulation.origin.x}px, ${simulation.pointer.y - simulation.origin.y}px, 0)`
  }
}

function stopFairyParticles(layerOrSimulation) {
  const simulation = layerOrSimulation?.workflowFairySimulation || layerOrSimulation
  if (!simulation?.active) return
  simulation.active = false
  cancelAnimationFrame(simulation.raf)
  const layer = simulation.card?.querySelector('.workflow-card__particles')
  if (layer?.workflowFairySimulation === simulation) {
    delete layer.workflowFairySimulation
    layer.style.transform = ''
    layer.replaceChildren()
  }
}

function buildBorderTrack(width, height, r, direction) {
  const middleY = height / 2
  const segments = direction === 'up'
    ? [
        { type: 'line', x1: 0, y1: middleY, x2: 0, y2: r },
        { type: 'arc', cx: r, cy: r, r, start: Math.PI, end: 1.5 * Math.PI },
        { type: 'line', x1: r, y1: 0, x2: width - r, y2: 0 },
        { type: 'arc', cx: width - r, cy: r, r, start: 1.5 * Math.PI, end: 2 * Math.PI },
        { type: 'line', x1: width, y1: r, x2: width, y2: middleY }
      ]
    : [
        { type: 'line', x1: 0, y1: middleY, x2: 0, y2: height - r },
        { type: 'arc', cx: r, cy: height - r, r, start: Math.PI, end: Math.PI / 2 },
        { type: 'line', x1: r, y1: height, x2: width - r, y2: height },
        { type: 'arc', cx: width - r, cy: height - r, r, start: Math.PI / 2, end: 0 },
        { type: 'line', x1: width, y1: height - r, x2: width, y2: middleY }
      ]
  const segmentLengths = segments.map((segment) => (
    segment.type === 'line'
      ? Math.hypot(segment.x2 - segment.x1, segment.y2 - segment.y1)
      : Math.abs(segment.end - segment.start) * segment.r
  ))
  const totalLength = segmentLengths.reduce((sum, length) => sum + length, 0)
  const sample = (progress) => {
    let distance = Math.max(0, Math.min(1, progress)) * totalLength
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index]
      const length = segmentLengths[index]
      if (distance <= length || index === segments.length - 1) {
        const t = length ? Math.min(1, distance / length) : 0
        if (segment.type === 'line') {
          return {
            x: segment.x1 + (segment.x2 - segment.x1) * t,
            y: segment.y1 + (segment.y2 - segment.y1) * t
          }
        }
        const angle = segment.start + (segment.end - segment.start) * t
        return {
          x: segment.cx + segment.r * Math.cos(angle),
          y: segment.cy + segment.r * Math.sin(angle)
        }
      }
      distance -= length
    }
    return { x: width, y: middleY }
  }
  return { sample, totalLength }
}

function animatePickupParticles(layer, card) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    return { duration: 0, cancel() {}, reverse() {} }
  }

  const measureCard = () => {
    const rect = card.getBoundingClientRect()
    const style = window.getComputedStyle(card)
    const borderLeft = parseFloat(style.borderLeftWidth) || 0
    const borderRight = parseFloat(style.borderRightWidth) || 0
    const borderTop = parseFloat(style.borderTopWidth) || 0
    const borderBottom = parseFloat(style.borderBottomWidth) || 0
    const borderRadius = parseFloat(style.borderTopLeftRadius) || 0
    const left = rect.left + borderLeft / 2
    const top = rect.top + borderTop / 2
    const width = Math.max(0, rect.width - (borderLeft + borderRight) / 2)
    const height = Math.max(0, rect.height - (borderTop + borderBottom) / 2)
    const radius = Math.min(
      Math.max(0, borderRadius - Math.max(borderLeft, borderTop) / 2),
      width * 0.5,
      height * 0.5
    )
    return { left, top, width, height, radius }
  }

  const initialRect = measureCard()
  const width = initialRect.width
  const height = initialRect.height
  const radius = initialRect.radius
  const particlesPerTrack = 170
  const tracks = [
    buildBorderTrack(width, height, radius, 'up'),
    buildBorderTrack(width, height, radius, 'down')
  ]
  const speed = Math.min(2, Math.max(0.25, Number(getUserSettings().workflowBorderParticleSpeed) || 1))
  const movementDuration = 2200 / 2.3 / speed
  const launchWindow = 1500 / 2.3 / speed
  const exitDistance = 64
  const exitDuration = 420 / 2.3 / speed
  const totalDuration = launchWindow + movementDuration + exitDuration
  const particles = []
  let rafId = 0
  let stopped = false
  let startTime = 0
  let burstStartedAt = 0
  let burstOrigin = null
  let previousWidth = width
  let previousHeight = height
  let previousRadius = radius

  layer.style.left = '0'
  layer.style.top = '0'
  layer.style.width = '100vw'
  layer.style.height = '100vh'

  tracks.forEach((track) => {
    for (let index = 0; index < particlesPerTrack; index += 1) {
      const particle = document.createElement('i')
      const progress = index / (particlesPerTrack - 1)
      particle.className = 'workflow-card__particle workflow-card__particle--pickup'
      particle.style.setProperty('--particle-size', `${1 + Math.random() * 1.4}px`)
      layer.append(particle)
      particles.push({
        element: particle,
        track,
        delay: progress * launchWindow,
        scale: 0.8 + Math.random() * 0.55,
        opacity: 0.84 + Math.random() * 0.16,
        burstX: (Math.random() - 0.5) * 2,
        burstY: (Math.random() - 0.5) * 2,
        burstDistance: 24 + Math.random() * 68,
        burstScale: 0.7 + Math.random() * 1.4
      })
    }
  })

  const renderFrame = (now) => {
    if (stopped) return
    if (!startTime) {
      startTime = now
    }
    const elapsed = burstOrigin ? 0 : now - startTime
    if (!card.isConnected && !burstOrigin) {
      stopped = true
      particles.forEach(({ element }) => element.remove())
      layer.remove()
      return
    }
    const rect = measureCard()
    if (!burstOrigin && (
      Math.abs(rect.width - previousWidth) > 0.5 ||
      Math.abs(rect.height - previousHeight) > 0.5 ||
      Math.abs(rect.radius - previousRadius) > 0.5
    )) {
      previousWidth = rect.width
      previousHeight = rect.height
      previousRadius = rect.radius
      tracks[0] = buildBorderTrack(rect.width, rect.height, rect.radius, 'up')
      tracks[1] = buildBorderTrack(rect.width, rect.height, rect.radius, 'down')
      particles.forEach((particle, index) => {
        particle.track = tracks[Math.floor(index / particlesPerTrack)]
      })
    }

    if (burstOrigin) {
      const burstElapsed = now - burstStartedAt
      const burstDuration = 620
      const burstProgress = Math.min(1, burstElapsed / burstDuration)
      const easedBurstProgress = 1 - (1 - burstProgress) ** 2
      particles.forEach(({ element, burstX, burstY, burstDistance, burstScale, opacity }) => {
        const x = burstOrigin.left + burstX * burstDistance * easedBurstProgress
        const y = burstOrigin.top + burstY * burstDistance * easedBurstProgress
        element.style.left = `${x}px`
        element.style.top = `${y}px`
        element.style.opacity = String(opacity * (1 - burstProgress))
        element.style.transform = `translate(-50%, -50%) scale(${1 + burstScale * burstProgress})`
      })
      if (burstProgress < 1) {
        rafId = requestAnimationFrame(renderFrame)
      } else {
        stopped = true
        particles.forEach(({ element }) => element.remove())
        layer.remove()
      }
      return
    }

    particles.forEach(({ element, track, delay, scale, opacity }) => {
      const particleElapsed = elapsed - delay
      if (particleElapsed < 0 || particleElapsed > movementDuration + exitDuration) {
        element.style.opacity = '0'
        return
      }
      const routeProgress = Math.min(1, particleElapsed / movementDuration)
      const point = track.sample(routeProgress)
      const isExiting = particleElapsed > movementDuration
      const exitProgress = isExiting
        ? Math.min(1, (particleElapsed - movementDuration) / exitDuration)
        : 0
      const x = isExiting ? rect.width + exitDistance * exitProgress : point.x
      const y = isExiting ? rect.height / 2 : point.y
      const fadeIn = Math.min(1, particleElapsed / 90)
      const fadeOut = isExiting ? 1 - exitProgress : 1
      const currentScale = scale * (isExiting ? 1 + 0.2 * (1 - exitProgress) : 1)
      element.style.left = `${rect.left + x}px`
      element.style.top = `${rect.top + y}px`
      element.style.opacity = String(opacity * fadeIn * fadeOut)
      element.style.transform = `translate(-50%, -50%) scale(${currentScale})`
    })

    if (elapsed < totalDuration) rafId = requestAnimationFrame(renderFrame)
  }

  rafId = requestAnimationFrame(renderFrame)
  return {
    duration: totalDuration,
    reverse() {
      if (stopped || burstOrigin) return 0
      const rect = measureCard()
      burstOrigin = {
        left: rect.left + rect.width / 2,
        top: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
        radius: rect.radius
      }
      const origin = { ...burstOrigin }
      particles.forEach((particle) => {
        const elapsed = startTime ? performance.now() - startTime - particle.delay : -particle.delay
        if (elapsed < 0) {
          particle.burstX = (Math.random() - 0.5) * 2
          particle.burstY = (Math.random() - 0.5) * 2
          particle.burstDistance = 12 + Math.random() * 52
          particle.element.style.left = `${origin.left}px`
          particle.element.style.top = `${origin.top}px`
          particle.element.style.opacity = String(particle.opacity * 0.75)
          particle.element.style.transform = `translate(-50%, -50%) scale(${particle.scale})`
        }
      })
      burstStartedAt = performance.now()
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(renderFrame)
      return 620 / 2.3 / speed
    },
    cancel() {
      stopped = true
      cancelAnimationFrame(rafId)
      particles.forEach(({ element }) => element.remove())
      layer.remove()
    }
  }
}

function toggleItem(id, { forced = false } = {}) {
  const task = getWorkflows().find((t) => t.id === id)
  if (!forced && task && task.checkConfig && task.checkConfig.enabled) {
    DBG('toggleItem:blocked-check-lock', { id })
    showToast(I18N.toast.workflow.systemCheckOnly)
    renderWorkflow()
    return
  }
  // 搁置任务：业务层拦截，避免绕过 checkbox disabled 状态完成任务。
  // 搁置与完成互斥，已搁置任务不可被强制完成。
  if (!forced && isTaskSnoozed(id)) {
    DBG('toggleItem:blocked-snoozed', { id })
    showToast(I18N.toast.workflow.taskSnoozed)
    renderWorkflow()
    return
  }
  // 前置任务检查
  if (!forced && task) {
    const { ready, missingIds } = checkPrerequisites(task)
    if (!ready && missingIds.length > 0) {
    const workflows = getWorkflows()
      const otherTasks = workflows.filter((t) => missingIds.includes(t.id))
      const list = otherTasks.map((t) => `#${String(workflows.indexOf(t) + 1).padStart(2, '0')}`).join(', ')
      showToast(t(I18N.toast.workflow.prerequisitesLocked, { list }))
      renderWorkflow()
      return
    }
  }
  const before = getCompletedIds().has(id)
  DBG('toggleItem:enter', { id, forced, before })
  const after = toggleCompleted(id)
  const persisted = persistCompleted()
  if (!persisted) showToast(I18N.toast.workflow.updateStorageFail)
  if (after !== before) {
    renderWorkflow()
    if (getUserSettings().advancedVisual) {
      requestAnimationFrame(() => {
        const card = document.querySelector(`.workflow-card[data-item-id="${id}"]`)
        if (!card) return
        const cls = after ? 'is-just-checked' : 'is-just-unchecked'
        if (!after) {
          const pickupAnimation = card._workflowPickupAnimation
          if (pickupAnimation) {
            const fadeDuration = pickupAnimation.reverse()
            if (fadeDuration > 0) {
              card.classList.remove('is-just-checked')
              card._workflowPickupAnimation = null
              setTimeout(() => {
                pickupAnimation.cancel()
              }, fadeDuration + 40)
            }
          }
        }
        card.classList.add(cls)
        if (after) {
          const particleLayer = document.createElement('div')
          particleLayer.className = 'workflow-pickup-overlay'
          particleLayer.setAttribute('aria-hidden', 'true')
          document.body.append(particleLayer)
          const animation = animatePickupParticles(particleLayer, card)
          card._workflowPickupAnimation = animation
          setTimeout(() => {
            card.classList.remove(cls)
            if (card._workflowPickupAnimation === animation) {
              delete card._workflowPickupAnimation
            }
            animation.cancel()
          }, animation.duration + 80)
          return
        }
        setTimeout(() => {
          card.classList.remove(cls)
        }, 650)
      })
    }
  }
  showToast(after ? I18N.toast.workflow.completed : I18N.toast.workflow.reopened)
}

// 幂等写操作 300ms 节流：连点「切换/完成」时只放行一次，
// 避免短时间内放大写放大与全量重渲染；leading 保留首次即时反馈，
// trailing 在窗口结束后再补一次以保证最终状态一致。
const toggleItemThrottled = throttle(toggleItem, 300)

export function bindWorkflowListEvents() {
  const list = document.querySelector('#workflow-list')
  if (!list) return

  // 批量绑定工作流列表事件
  const workflowEvents = [
    {
      event: 'pointermove',
      handler: (event) => {
        if (!getUserSettings().advancedVisual || event.pointerType === 'touch') return
        const card = event.target.closest('.workflow-card')
        if (!card || !list.contains(card) || card.classList.contains('is-placeholder')) return
        const particleLayer = card.querySelector('.workflow-card__particles')
        if (!particleLayer || card.classList.contains('is-just-checked')) return
        const cardRect = card.getBoundingClientRect()
        const pointerX = event.clientX - cardRect.left
        const pointerY = event.clientY - cardRect.top
        if (!card.classList.contains('is-pointer-active')) {
          card.classList.add('is-pointer-active')
          createFairyParticles(particleLayer, cardRect, pointerX, pointerY)
        } else {
          updateFairyParticles(particleLayer, cardRect, pointerX, pointerY)
        }
      }
    },
    {
      event: 'pointerout',
      handler: (event) => {
        const card = event.target.closest('.workflow-card')
        if (card && (!event.relatedTarget || !card.contains(event.relatedTarget))) {
          card.classList.remove('is-pointer-active')
          stopFairyParticles(card.querySelector('.workflow-card__particles'))
        }
      }
    },
    {
      event: 'change',
      handler: (event) => {
        const checkbox = event.target.closest('[data-item-id]')
        if (checkbox) toggleItemThrottled(checkbox.dataset.itemId)
      }
    },
    {
      event: 'click',
      handler: (event) => {
        const btn = event.target.closest('[data-check-action]')
        if (!btn) return
        const action = btn.dataset.checkAction
        const taskId = btn.dataset.itemId
        if (action === 'memo-count') {
          runMemoCountCheck(taskId)
        }
      }
    }
  ]

  // 绑定事件
  bindBatch(list, workflowEvents)

  // 返回清理函数，用于组件销毁时清理事件
  return () => {
    // 清理事件监听器
    list.replaceWith(list.cloneNode(true))
  }
}

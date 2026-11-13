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

const FAIRY_PARTICLE_CONFIG = Object.freeze({
  count: 64,
  followStrength: 7.2,
  followDamping: 2.8,
  brownianStrength: 24,
  brownianTurnRate: 1.8,
  dockRadius: 34,
  dockWidth: 26,
  minimumSpacing: 6,
  separationStrength: 18,
  maxSpeed: 155,
  maxDeltaTime: 0.05,
  pointerStillDelay: 0.08,
  pointerEpsilon: 1.5
})

function createFairyParticle(pointerX, pointerY, cardRect) {
  const particle = document.createElement('i')
  const angle = Math.random() * Math.PI * 2
  const radius = FAIRY_PARTICLE_CONFIG.dockRadius + (Math.random() - 0.5) * FAIRY_PARTICLE_CONFIG.dockWidth
  const x = Math.min(cardRect.width, Math.max(0, pointerX + Math.cos(angle) * radius))
  const y = Math.min(cardRect.height, Math.max(0, pointerY + Math.sin(angle) * radius))
  const state = {
    element: particle,
    x,
    y,
    vx: (Math.random() - 0.5) * 10,
    vy: (Math.random() - 0.5) * 10,
    brownianX: Math.random() * 2 - 1,
    brownianY: Math.random() * 2 - 1,
    brownianPhase: Math.random() * Math.PI * 2,
    response: 0.7 + Math.random() * 0.7,
    mass: 0.75 + Math.random() * 0.8,
    angle,
    radius,
    seed: Math.random() * 100
  }
  particle.className = 'workflow-card__particle'
  particle.style.setProperty('--particle-size', `${1 + Math.random() * 1.2}px`)
  particle.style.setProperty('--particle-opacity', `${0.42 + Math.random() * 0.38}`)
  return state
}

function createFairyParticles(layer, cardRect, pointerX, pointerY) {
  const fragment = document.createDocumentFragment()
  const simulation = {
    pointer: { x: pointerX, y: pointerY },
    previousPointer: { x: pointerX, y: pointerY },
    pointerStillFor: 0,
    particles: [],
    raf: 0,
    lastTime: 0,
    active: true,
    card: layer.closest('.workflow-card')
  }
  for (let index = 0; index < FAIRY_PARTICLE_CONFIG.count; index += 1) {
    const state = createFairyParticle(pointerX, pointerY, cardRect)
    simulation.particles.push(state)
    fragment.append(state.element)
  }
  layer.replaceChildren(fragment)
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
  simulation.pointerStillFor = 0
  if (!simulation.raf) {
    simulation.raf = requestAnimationFrame((time) => stepFairyParticles(simulation, layer, time))
  }
}

function clampMagnitude(x, y, max) {
  const magnitude = Math.hypot(x, y)
  if (magnitude <= max || magnitude === 0) return { x, y }
  const scale = max / magnitude
  return { x: x * scale, y: y * scale }
}

function stepFairyParticles(simulation, layer, now) {
  simulation.raf = 0
  if (
    !simulation.active ||
    !simulation.card?.isConnected ||
    !document.body.classList.contains('is-advanced-visual') ||
    document.hidden ||
    !simulation.card.matches(':hover')
  ) {
    stopFairyParticles(simulation)
    return
  }
  const previous = simulation.lastTime || now
  simulation.lastTime = now
  const dt = Math.min(FAIRY_PARTICLE_CONFIG.maxDeltaTime, Math.max(0.001, (now - previous) / 1000))
  const pointerDelta = Math.hypot(
    simulation.pointer.x - simulation.previousPointer.x,
    simulation.pointer.y - simulation.previousPointer.y
  )
  simulation.pointerStillFor = pointerDelta > FAIRY_PARTICLE_CONFIG.pointerEpsilon
    ? 0
    : simulation.pointerStillFor + dt
  simulation.previousPointer.x = simulation.pointer.x
  simulation.previousPointer.y = simulation.pointer.y
  const driftSpeed = Math.min(10, Math.max(0.01, Number(getUserSettings().workflowFairyDriftSpeed) || 1))
  const chaseSpeed = Math.min(10, Math.max(0.01, Number(getUserSettings().workflowFairyChaseSpeed) || 1))

  for (const particle of simulation.particles) {
    const toPointerX = simulation.pointer.x - particle.x
    const toPointerY = simulation.pointer.y - particle.y
    const distance = Math.hypot(toPointerX, toPointerY) || 0.001
    const desiredRadius = FAIRY_PARTICLE_CONFIG.dockRadius + particle.radius * 0.12
    const radialError = distance - desiredRadius
    // 静止态把追逐力压得更低，让漂游速率设置成为主导，否则强阻尼会吃掉速率差异。
    const chaseScale = simulation.pointerStillFor < FAIRY_PARTICLE_CONFIG.pointerStillDelay ? 1 : 0.16
    let forceX = (toPointerX / distance) * radialError * FAIRY_PARTICLE_CONFIG.followStrength * chaseScale * chaseSpeed
    let forceY = (toPointerY / distance) * radialError * FAIRY_PARTICLE_CONFIG.followStrength * chaseScale * chaseSpeed
    const tangentX = -toPointerY / distance
    const tangentY = toPointerX / distance
    const brownianTime = now / 1000 * FAIRY_PARTICLE_CONFIG.brownianTurnRate * particle.response + particle.seed
    particle.brownianX += (Math.sin(brownianTime * 1.13) - particle.brownianX) * dt * 2
    particle.brownianY += (Math.cos(brownianTime * 0.87) - particle.brownianY) * dt * 2
    forceX += (tangentX * particle.brownianX + (toPointerX / distance) * particle.brownianY) * FAIRY_PARTICLE_CONFIG.brownianStrength * driftSpeed
    forceY += (tangentY * particle.brownianX + (toPointerY / distance) * particle.brownianY) * FAIRY_PARTICLE_CONFIG.brownianStrength * driftSpeed
    for (const other of simulation.particles) {
      if (other === particle) continue
      const awayX = particle.x - other.x
      const awayY = particle.y - other.y
      const separation = Math.hypot(awayX, awayY)
      if (separation > 0 && separation < FAIRY_PARTICLE_CONFIG.minimumSpacing) {
        const weight = (FAIRY_PARTICLE_CONFIG.minimumSpacing - separation) / separation
        forceX += awayX * weight * FAIRY_PARTICLE_CONFIG.separationStrength
        forceY += awayY * weight * FAIRY_PARTICLE_CONFIG.separationStrength
      }
    }
    const damping = FAIRY_PARTICLE_CONFIG.followDamping * particle.response
    particle.vx += (forceX / particle.mass - damping * particle.vx) * dt
    particle.vy += (forceY / particle.mass - damping * particle.vy) * dt
    const velocity = clampMagnitude(particle.vx, particle.vy, FAIRY_PARTICLE_CONFIG.maxSpeed * (0.65 + particle.response * 0.35))
    particle.vx = velocity.x
    particle.vy = velocity.y
    particle.x += particle.vx * dt
    particle.y += particle.vy * dt
    particle.element.style.setProperty('--particle-x', `${particle.x}px`)
    particle.element.style.setProperty('--particle-y', `${particle.y}px`)
  }
  simulation.raf = requestAnimationFrame((time) => stepFairyParticles(simulation, layer, time))
}

function stopFairyParticles(layerOrSimulation) {
  const simulation = layerOrSimulation?.workflowFairySimulation || layerOrSimulation
  if (!simulation) return
  simulation.active = false
  if (simulation.raf) {
    cancelAnimationFrame(simulation.raf)
    simulation.raf = 0
  }
  const layer = simulation.card?.querySelector('.workflow-card__particles')
  if (layer?.workflowFairySimulation === simulation) {
    delete layer.workflowFairySimulation
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
  const speed = Math.min(10, Math.max(0.01, Number(getUserSettings().workflowBorderParticleSpeed) || 1))
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

  const stopVisibleParticleSimulations = () => {
    list.querySelectorAll('.workflow-card__particles').forEach((layer) => {
      stopFairyParticles(layer)
    })
    list.querySelectorAll('.workflow-card.is-pointer-active').forEach((card) => {
      card.classList.remove('is-pointer-active')
    })
  }
  document.addEventListener('visibilitychange', stopVisibleParticleSimulations)

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
    document.removeEventListener('visibilitychange', stopVisibleParticleSimulations)
    stopVisibleParticleSimulations()
    list.replaceWith(list.cloneNode(true))
  }
}

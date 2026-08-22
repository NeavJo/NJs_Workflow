let enabled = true

export function setDebugEnabled(value) {
  enabled = Boolean(value)
}

export function isDebugEnabled() {
  return enabled
}

export function DBG(tag, detail) {
  if (!enabled) return
  console.log(`[NJsWorkflow:${tag}]`, detail)
}

export function registerDebugHook(buildSnapshot) {
  if (typeof window === 'undefined') return
  window.debugNJ = () => {
    const payload = typeof buildSnapshot === 'function' ? buildSnapshot() : null
    console.groupCollapsed('[NJsWorkflow] 内存实时快照')
    if (payload) console.log('payload', payload)
    console.groupEnd()
    return payload
  }
}

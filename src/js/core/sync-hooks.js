let autoUploadHandler = null
let autoUploadSuspended = 0

export function registerAutoUploadHandler(fn) {
  autoUploadHandler = typeof fn === 'function' ? fn : null
}

export function requestAutoUpload() {
  if (autoUploadSuspended > 0) return
  if (autoUploadHandler) autoUploadHandler()
}

export function suspendAutoUpload() {
  autoUploadSuspended += 1
}

export function resumeAutoUpload() {
  autoUploadSuspended = Math.max(0, autoUploadSuspended - 1)
}

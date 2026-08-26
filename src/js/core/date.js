export function pad2(n) {
  return String(n).padStart(2, '0')
}

export function getTodayDateString(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function getYesterdayDateString(d = new Date()) {
  const y = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)
  return getTodayDateString(y)
}

export function getFullTimestamp(d = new Date()) {
  return `${getTodayDateString(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function formatTimestamp(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

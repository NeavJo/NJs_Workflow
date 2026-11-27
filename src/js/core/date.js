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

/**
 * 生成用于文件名的紧凑时间戳：YYYYMMDD_HHmmss（本地时间）。
 * 批量导出文件名需要精确到秒，避免同一分钟内多次导出互相覆盖。
 */
export function getCompactTimestamp(d = new Date()) {
  const date = getTodayDateString(d).replace(/-/g, '')
  return `${date}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

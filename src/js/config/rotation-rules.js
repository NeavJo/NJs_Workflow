/**
 * 通用「周几轮换规则 (RotationRule)」引擎
 */
export const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

export const DEFAULT_ROTATION_RULES = [
  {
    id: 'rot-cet6',
    name: 'CET-6 每日专项',
    days: [
      { label: '今日专项：听力', icon: 'headphones', variant: 'accent' },
      { label: '今日专项：写作', icon: 'edit_note', variant: 'accent' },
      { label: '今日专项：翻译', icon: 'translate', variant: 'accent' },
      { label: '今日专项：选词填空', icon: 'join', variant: 'accent' },
      { label: '今日专项：长篇阅读', icon: 'article', variant: 'accent' },
      { label: '今日专项：仔细阅读', icon: 'menu_book', variant: 'accent' },
      { label: '周六：休息日（不计入今日进度）', icon: 'coffee', variant: 'muted', disabled: true }
    ]
  }
]

export const ROTATION_RULES_STORAGE_KEY = 'njs-workflow-rotation-rules'

export const CET6_LEGACY_RULE_ID = 'rot-cet6'

export function createEmptyDayEntry() {
  return { label: '', icon: 'label', disabled: false }
}

export function createRotationRule(overrides = {}) {
  const base = {
    id: `rot-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    name: '未命名轮换规则',
    days: Array.from({ length: 7 }, createEmptyDayEntry)
  }
  return { ...base, ...overrides, days: overrides.days || base.days }
}

export function normalizeDayEntry(raw) {
  if (!raw || typeof raw !== 'object') return createEmptyDayEntry()
  return {
    label: typeof raw.label === 'string' ? raw.label : '',
    icon: typeof raw.icon === 'string' && raw.icon ? raw.icon : 'label',
    disabled: Boolean(raw.disabled),
    variant: raw.variant === 'muted' ? 'muted' : 'accent'
  }
}

export function normalizeRotationRule(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (typeof raw.id !== 'string' || !raw.id) return null
  const days = Array.isArray(raw.days) ? raw.days.slice(0, 7) : []
  while (days.length < 7) days.push(createEmptyDayEntry())
  return {
    id: raw.id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : '未命名轮换规则',
    days: days.map(normalizeDayEntry)
  }
}

export function normalizeRotationRuleList(rawList) {
  if (!Array.isArray(rawList)) return []
  return rawList.map(normalizeRotationRule).filter(Boolean)
}

export function evaluateRotationTag(rule, dayIndex = new Date().getDay()) {
  if (!rule || !Array.isArray(rule.days) || rule.days.length < 7) return null
  const entry = normalizeDayEntry(rule.days[dayIndex])
  if (!entry.label && !entry.icon) return null
  const variant = entry.disabled
    ? 'muted'
    : (entry.variant === 'muted' ? 'muted' : 'accent')
  return {
    label: entry.label || '',
    icon: entry.icon || 'label',
    variant,
    disabled: Boolean(entry.disabled)
  }
}

export function getCet6DailySpecial() {
  const cet6 = DEFAULT_ROTATION_RULES.find((r) => r.id === CET6_LEGACY_RULE_ID)
  return evaluateRotationTag(cet6)
}

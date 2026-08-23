/**
 * 通用「周几轮换规则 (RotationRule)」引擎
 */
import { I18N } from '../locales.js'

export const WEEKDAY_LABELS = I18N.common.weekdays
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

export const DEFAULT_ROTATION_RULES = [
  {
    id: 'rot-cet6',
    name: I18N.defaults.cet6RuleName,
    days: I18N.defaults.cet6Days.map((label, i) => ({
      label,
      icon: ['headphones', 'edit_note', 'translate', 'join', 'article', 'menu_book', 'coffee'][i],
      variant: i === 6 ? 'muted' : 'accent',
      disabled: i === 6
    }))
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
    name: I18N.defaults.untitledRule,
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
    name: typeof raw.name === 'string' && raw.name ? raw.name : I18N.defaults.untitledRule,
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
  // 只要 label 为空就隐藏标签（即使有图标）
  if (!entry.label) return null
  const variant = entry.disabled
    ? 'muted'
    : (entry.variant === 'muted' ? 'muted' : 'accent')
  return {
    label: entry.label,
    icon: entry.icon || 'label',
    variant,
    disabled: Boolean(entry.disabled)
  }
}

export function getCet6DailySpecial() {
  const cet6 = DEFAULT_ROTATION_RULES.find((r) => r.id === CET6_LEGACY_RULE_ID)
  return evaluateRotationTag(cet6)
}

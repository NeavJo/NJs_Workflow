import { CET6_LEGACY_RULE_ID } from './rotation-rules.js'

export const DEFAULT_WORKFLOWS = [
  {
    id: 'task-1',
    title: 'Tageschau in einfacher Sprache',
    desc: '观看最新一期',
    url: 'https://youtube.com/playlist?list=PLkKDSXRppVa5AtZJ_QzQXG_fusxuC1dGw&si=9k3o9AlIYgIyQyqN',
    type: 'jump_and_check',
    isPlaceholder: false,
    hasDynamicTag: false,
    rotationRuleId: null
  },
  {
    id: 'task-1-1',
    title: '输入视频中的生词（至少7个）',
    desc: '校验今日 tgs 分类生词数（≥7 自动打卡）',
    url: null,
    type: 'check_only',
    isPlaceholder: false,
    hasDynamicTag: false,
    rotationRuleId: null,
    checkConfig: { enabled: true, category: 'tgs', targetCount: 7 }
  },
  {
    id: 'task-2',
    title: '复习 CET-6',
    desc: null,
    url: null,
    type: 'check_only',
    isPlaceholder: false,
    hasDynamicTag: true,
    rotationRuleId: CET6_LEGACY_RULE_ID
  },
  {
    id: 'task-3',
    title: 'Anki - Deutsch',
    desc: null,
    url: null,
    type: 'check_only',
    isPlaceholder: false,
    hasDynamicTag: false,
    rotationRuleId: null
  },
  {
    id: 'task-4',
    title: 'Anki - English',
    desc: null,
    url: null,
    type: 'check_only',
    isPlaceholder: false,
    hasDynamicTag: false,
    rotationRuleId: null
  },
  {
    id: 'task-5',
    title: 'Anki - 导入',
    desc: '确认将今天生成的德语生词与英语生词批量导入 Anki',
    url: null,
    type: 'check_only',
    isPlaceholder: false,
    hasDynamicTag: false,
    rotationRuleId: null
  },
  {
    id: 'task-6',
    title: 'Anki - 清理旗标',
    desc: null,
    url: null,
    type: 'check_only',
    isPlaceholder: false,
    hasDynamicTag: false,
    rotationRuleId: null
  }
]

export function createTask(overrides = {}) {
  return {
    id: `task-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    title: '',
    desc: null,
    url: null,
    type: 'check_only',
    isPlaceholder: false,
    hasDynamicTag: false,
    rotationRuleId: null,
    checkConfig: null,
    ...overrides
  }
}

export function normalizeCheckConfig(raw) {
  if (!raw || typeof raw !== 'object') return null
  const enabled = Boolean(raw.enabled)
  const category = typeof raw.category === 'string' ? raw.category.trim() : ''
  let targetCount = parseInt(raw.targetCount, 10)
  if (!Number.isFinite(targetCount) || targetCount < 1) targetCount = 7
  return { enabled, category, targetCount }
}

export function normalizeTask(raw) {
  if (!raw || typeof raw !== 'object') return null
  const rawRot = typeof raw.rotationRuleId === 'string' && raw.rotationRuleId ? raw.rotationRuleId : null
  const rawLegacy = Boolean(raw.hasDynamicTag)
  const rotationRuleId = rawRot || (rawLegacy ? CET6_LEGACY_RULE_ID : null)

  let checkConfig = normalizeCheckConfig(raw.checkConfig)
  if (!checkConfig && typeof raw.checkAction === 'string' && raw.checkAction === 'tgs-word-count') {
    checkConfig = { enabled: true, category: 'tgs', targetCount: 7 }
  }

  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : `task-${Date.now()}`,
    title: typeof raw.title === 'string' ? raw.title : '未命名任务',
    desc: typeof raw.desc === 'string' && raw.desc ? raw.desc : null,
    url: typeof raw.url === 'string' && raw.url ? raw.url : null,
    type: raw.type === 'jump_and_check' ? 'jump_and_check' : 'check_only',
    isPlaceholder: Boolean(raw.isPlaceholder),
    hasDynamicTag: rawLegacy || Boolean(rotationRuleId),
    rotationRuleId,
    checkConfig
  }
}

/**
 * ============================================================
 *  config.js —— 兼容层
 *  旧代码 / 旧 import 仍可继续从这里导入符号。
 *  所有实现已经拆到 src/js/config/* 下的子模块。
 * ============================================================
 */
export {
  WEEKDAY_LABELS,
  WEEKDAY_ORDER,
  DEFAULT_ROTATION_RULES,
  ROTATION_RULES_STORAGE_KEY,
  CET6_LEGACY_RULE_ID,
  createEmptyDayEntry,
  createRotationRule,
  normalizeDayEntry,
  normalizeRotationRule,
  normalizeRotationRuleList,
  evaluateRotationTag,
  getCet6DailySpecial
} from './config/rotation-rules.js'

export {
  MEMO_TAGS_STORAGE_KEY,
  DEFAULT_MEMO_TAGS,
  normalizeMemoTag,
  normalizeMemoTagList
} from './config/memo-tags.js'

export {
  DEFAULT_WORKFLOWS,
  createTask,
  normalizeCheckConfig,
  normalizeTask
} from './config/workflow-config.js'

export {
  WORKFLOWS_STORAGE_KEY,
  COMPLETION_HISTORY_STORAGE_KEY,
  LAST_RESET_DATE_STORAGE_KEY,
  GIST_SETTINGS_STORAGE_KEY,
  USER_SETTINGS_STORAGE_KEY,
  ANKI_SETTINGS_STORAGE_KEY,
  DEFAULT_GIST_SETTINGS,
  DEFAULT_USER_SETTINGS,
  DEFAULT_ANKI_SETTINGS,
  ANKI_API_TYPES,
  normalizeGistSettings,
  normalizeCompletionHistory,
  normalizeUserSettings,
  normalizeAnkiSettings
} from './config/storage-config.js'

export { pad2, getTodayDateString, getYesterdayDateString, getFullTimestamp, formatTimestamp } from './core/date.js'

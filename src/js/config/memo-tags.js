export const MEMO_TAGS_STORAGE_KEY = 'njs-workflow-memo-tags'

export const DEFAULT_MEMO_TAGS = [
  { id: '#Deutsch/Anki', name: 'Deutsch/Anki', icon: 'translate', isLocked: true },
  { id: '#English/Anki', name: 'English/Anki', icon: 'menu_book', isLocked: false },
  { id: '#CET-6', name: 'CET-6', icon: 'edit_note', isLocked: false }
]

export function normalizeMemoTag(raw) {
  if (!raw || typeof raw !== 'object') return null
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  const id = typeof raw.id === 'string' && raw.id ? raw.id : `#${name || '未命名'}`
  if (!name) return null
  const icon = typeof raw.icon === 'string' && raw.icon ? raw.icon : 'label'
  return { id, name, icon, isLocked: Boolean(raw.isLocked) }
}

export function normalizeMemoTagList(raw) {
  if (raw === null || raw === undefined) {
    return DEFAULT_MEMO_TAGS.map((t) => ({ ...t }))
  }
  const list = Array.isArray(raw) ? raw.map(normalizeMemoTag).filter(Boolean) : []
  const merged = [...list]
  for (const def of DEFAULT_MEMO_TAGS) {
    const existing = merged.find((t) => t.id === def.id)
    if (existing) {
      existing.isLocked = def.isLocked || existing.isLocked
    } else if (def.isLocked) {
      merged.push({ ...def })
    }
  }
  return merged
}

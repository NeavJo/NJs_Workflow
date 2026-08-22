/**
 * 笔记内容解析：将生词本卡片内容解析为 { 分类名: [生词...] }。
 * 同时提供 appendToCategory 用于追加生词到指定分类块。
 *
 * 卡片结构（块间空行分隔）：
 *   专四：
 *   deutlich
 *   im Gegensatz zu
 *
 *   常规：
 *   Tusche
 * 兼容老卡片（无分类头）：整体视为"常规"块。
 */

export function parseMemoContentToMap(content) {
  const map = {}
  const trimmed = (content || '').trim()
  if (!trimmed) return map

  const hasBlockHeader = trimmed.split('\n').some((line) => {
    const m = line.trim().match(/^(.+?)[：:]\s*$/)
    return m && m[1].trim().length > 0
  })

  if (!hasBlockHeader) {
    const words = trimmed.split('\n').map((l) => l.trim()).filter(Boolean)
    if (words.length) map['常规'] = words
    return map
  }

  const blocks = trimmed.split(/\n\s*\n/)
  for (const block of blocks) {
    const lines = block.split('\n')
    const header = lines[0].trim()
    const match = header.match(/^(.+?)[：:]\s*$/)
    if (match) {
      const cat = match[1].trim()
      const words = lines.slice(1).map((l) => l.trim()).filter(Boolean)
      if (!map[cat]) map[cat] = []
      map[cat].push(...words)
    } else {
      const words = lines.map((l) => l.trim()).filter(Boolean)
      if (words.length) {
        if (!map['常规']) map['常规'] = []
        map['常规'].push(...words)
      }
    }
  }
  return map
}

/**
 * 将生词追加到指定分类块。块不存在则创建；老卡片（无分类头）补上"常规"块。
 */
export function appendToCategory(content, category, word) {
  const trimmed = (content || '').trim()
  if (!trimmed) {
    return `${category}：\n${word}`
  }

  const hasBlockHeader = trimmed.split('\n').some((line) => {
    const m = line.trim().match(/^(.+?)[：:]\s*$/)
    return m && m[1].trim().length > 0
  })

  if (!hasBlockHeader) {
    // 老卡片：整体视为"常规"块
    return `${category}：\n${trimmed}\n${word}`
  }

  const blocks = trimmed.split(/\n\s*\n/)
  let appended = false
  const nextBlocks = blocks.map((block) => {
    const lines = block.split('\n')
    const header = lines[0].trim()
    const match = header.match(/^(.+?)[：:]\s*$/)
    if (match && match[1].trim() === category) {
      appended = true
      return `${header}\n${lines.slice(1).join('\n')}\n${word}`.replace(/^\n+/, '')
    }
    return block
  })
  if (!appended) {
    nextBlocks.push(`${category}：\n${word}`)
  }
  return nextBlocks.join('\n\n')
}

import fs from 'fs'
let src = fs.readFileSync('src/js/memo/memo-events.js', 'utf8')

const oldExpand = "  } else if (action === 'anki') {\n    processInAnki(card)\n  }\n}"
const newExpand = "  } else if (action === 'anki') {\n    processInAnki(card)\n  } else if (action === 'expand') {\n    toggleExpand(card)\n  }\n}"
src = src.replace(oldExpand, newExpand)

const toggleFn = \unction toggleExpand(card) {
  const contentEl = card.querySelector('.memo-card__content')
  const expandBtn = card.querySelector('.memo-card__expand')
  if (!contentEl) return
  const isCollapsed = contentEl.classList.contains('memo-card__content--collapsed')
  if (isCollapsed) {
    contentEl.classList.remove('memo-card__content--collapsed')
    if (expandBtn) {
      expandBtn.setAttribute('aria-label', I18N.memo.collapseAria)
      expandBtn.querySelector('.material-symbols').textContent = 'expand_less'
      expandBtn.querySelector('.memo-card__expand__label').textContent = I18N.memo.collapseBtn || '收起'
    }
  } else {
    contentEl.classList.add('memo-card__content--collapsed')
    if (expandBtn) {
      expandBtn.setAttribute('aria-label', I18N.memo.expandAria)
      expandBtn.querySelector('.material-symbols').textContent = 'expand_more'
      expandBtn.querySelector('.memo-card__expand__label').textContent = I18N.memo.expandBtn
    }
  }
}

\
src = src.replace('function enterEditMode(card, id) {', toggleFn + 'function enterEditMode(card, id) {')

const oldExpandInEnter = '  if (ankiBtn) ankiBtn.hidden = true\n  card.classList.add(\'is-editing\')'
const newExpandInEnter = '  if (ankiBtn) ankiBtn.hidden = true\n  const expandBtn = card.querySelector(\'.memo-card__expand\')\n  if (expandBtn) expandBtn.hidden = true\n  card.classList.add(\'is-editing\')'
src = src.replace(oldExpandInEnter, newExpandInEnter)

const oldExpandInExit = '  if (ankiBtn) ankiBtn.hidden = false\n  card.classList.remove(\'is-editing\')'
const newExpandInExit = '  if (ankiBtn) ankiBtn.hidden = false\n  const expandBtn = card.querySelector(\'.memo-card__expand\')\n  if (expandBtn) expandBtn.hidden = false\n  card.classList.remove(\'is-editing\')'
src = src.replace(oldExpandInExit, newExpandInExit)

fs.writeFileSync('src/js/memo/memo-events.js', src, 'utf8')
console.log('events updated')

import fs from 'fs'
let src = fs.readFileSync('src/js/memo/memo-renderer.js', 'utf8')

const oldPre = '      <pre class=\"memo-card__content\"></pre>'
const newPre = '      <pre class=\"memo-card__content\"></pre>'
src = src.replace(oldPre, newPre)

const ankiClose = '        <span class=\"memo-card__anki__label\"></span>\n      </button>\n    </div>'
const expandBtn = '        <span class=\"memo-card__anki__label\"></span>\n      </button>\n      <button class=\"memo-card__expand\" type=\"button\" data-memo-action=\"expand\" aria-label=\"\">\n        <span class=\"material-symbols\" aria-hidden=\"true\">expand_less</span>\n        <span class=\"memo-card__expand__label\"></span>\n      </button>\n    </div>'
src = src.replace(ankiClose, expandBtn)

fs.writeFileSync('src/js/memo/memo-renderer.js', src, 'utf8')
console.log('renderer updated')

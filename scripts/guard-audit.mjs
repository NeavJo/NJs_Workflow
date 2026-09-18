#!/usr/bin/env node
/**
 * guard-audit.mjs - 回归防线 CI 自检
 * -----------------------------------------------------------------------------
 * 扫描 src/js 下所有 .js，检测两类"会再次造成本次回归"的写法，
 * 命中即非 0 退出，阻断合并：
 *   1. 代码级 `document.dataset.` / `documentElement.dataset.` 直接属性访问
 *      （历史上 modal.js 用它做幂等守卫，body 解析前 undefined 抛 TypeError）
 *      → 正确做法：用 src/js/utils/guard.js 的 createGuard / isGuarded / markGuarded
 *      说明：文档注释 / 行注释里提到该写法不算违规。
 *   2. 仓库内出现直接 readFileSync / writeFileSync 改 src/js 源码的
 *      "裸补丁脚本"（历史上 4 个 fix_*.js 的教训）。
 *      说明：仅 scripts/guard-audit.mjs（本文件）自身被豁免，
 *      因为它只做"读"，从不"写"。
 *
 * 用法：node scripts/guard-audit.mjs
 * 退出码：0 = 全部通过；1 = 命中危险写法；2 = 运行异常
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(process.cwd())
const srcDir = path.join(root, 'src', 'js')
const repoRoot = root

/** 递归收集目录下所有 .js 文件 */
function collectJsFiles(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full))
    } else if (entry.isFile() && /\.js$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** 递归收集仓库根目录下的 .mjs / .cjs（排除 node_modules / dist） */
function collectPatchScripts(dir, depth = 0) {
  if (depth > 3 || !fs.existsSync(dir)) return []
  const out = []
  const skip = new Set(['node_modules', 'dist', '.git', '.trae'])
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectPatchScripts(full, depth + 1))
    } else if (entry.isFile() && /\.(mjs|cjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** 代码级 document.dataset / documentElement.dataset 属性访问 */
const DATASET_RE = /(^|[^.\w])(document|documentElement)\.dataset\.[A-Za-z_$][\w$]*/g
/** 行注释 / 块注释行（trim 后以 * // /* 开头）里的提及不算违规 */
function isCommentLine(line) {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

function audit() {
  const findings = [] // { rule, file, line, snippet, help }

  // 豁免：scripts/guard-audit.mjs 自身只做读操作，不参与"裸脚本改 src/js"判定
  const selfPath = path.join(root, 'scripts', 'guard-audit.mjs')

  // --- 规则 1：代码级 document.dataset 访问（扫描 src/js 下所有 .js） ---
  const jsFiles = collectJsFiles(srcDir)
  for (const file of jsFiles) {
    const rel = path.relative(root, file)
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return
      DATASET_RE.lastIndex = 0
      if (!DATASET_RE.exec(line)) return
      findings.push({
        rule: '代码级 document.dataset / documentElement.dataset 直接访问',
        file: rel,
        line: i + 1,
        snippet: line.trim().slice(0, 120),
        help: '幂等守卫请改用 src/js/utils/guard.js 的 createGuard / isGuarded / markGuarded，' +
          '禁止在代码里直接读写 document.dataset / documentElement.dataset（body 解析前可能 undefined）'
      })
    })
  }

  // --- 规则 2：裸 fs 改 src/js 源码（扫描仓库根 / 其它目录的 .js/.mjs/.cjs） ---
  const candidateScripts = [
    ...collectJsFiles(root).filter((f) => !f.startsWith(srcDir)),
    ...collectPatchScripts(repoRoot)
  ]
  const seen = new Set()
  for (const file of candidateScripts) {
    const key = file.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (key === selfPath.toLowerCase()) continue // 豁免本自检脚本
    const rel = path.relative(root, file)
    const text = fs.readFileSync(file, 'utf8')
    const inSrcJs = /src[\/\\]js\b/.test(text)
    const fsRef =
      /require\(['"]fs['"]\)/.test(text) ||
      /import\s+fs\s+from\s+['"]node:fs['"]/.test(text)
    const hasRead = /readFileSync\b/.test(text)
    const hasWrite = /writeFileSync\b/.test(text)
    if (inSrcJs && fsRef && (hasRead || hasWrite)) {
      findings.push({
        rule: '裸脚本改 src/js 源码（仓库根 / 其它目录）',
        file: rel,
        line: 1,
        snippet: '(整个文件命中 fs + src/js 路径)',
        help: '禁止在仓库内用裸脚本（fs 直读/直写）修改 src/js 源码；' +
          '所有改动必须通过编辑器 / 受控脚本 + git 提交，避免不可审计的"一键补丁"再次回归'
      })
    }
  }

  return findings
}

function main() {
  let findings
  try {
    findings = audit()
  } catch (e) {
    console.error('[guard-audit] 运行异常:', e)
    process.exit(2)
  }

  if (findings.length === 0) {
    console.log('[guard-audit] ✅ 通过：未发现裸 document.dataset / 裸 fs 改 src/js 的写法')
    process.exit(0)
    return
  }

  console.error(`[guard-audit] ❌ 命中 ${findings.length} 处危险写法：`)
  for (const f of findings) {
    console.error(`  · ${f.rule}`)
    console.error(`    位置: ${f.file}:${f.line}`)
    console.error(`    片段: ${f.snippet}`)
    console.error(`    建议: ${f.help}`)
    console.error('')
  }
  process.exit(1)
}

main()

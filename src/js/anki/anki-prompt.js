import { DBG } from '../core/debug.js'
import { getAnkiSettings } from './anki-store.js'

/**
 * Anki Prompt 模板加载器：
 *  - 默认提示词：内联在源码中，零网络请求，GitHub Pages / 任何部署方式稳定可用。
 *  - 自定义提示词：保存在 ankiSettings.prompt（随 Gist 一并同步），非空时优先使用。
 *  - loadAnkiPrompt() 返回当前生效的 System Prompt；为空时返回空字符串，调用方据此中止处理。
 */

const DEFAULT_PROMPT = `# Role
德语 Anki 卡片生成引擎。直接输出可导入 Anki 的纯文本流，严禁 Markdown 代码框或废话。

# Rules
1. **结构**：分类标题 \`=== [分类名] ===\`，每行 3 字段：\`[F1] | [F2] | [F3]\`。
2. **标点**：正文禁用 \`|\`；多释义用逗号（\`，\` 或 \`, \`）分隔。
3. **容错/指定**：修正拼写/大小写/变音；乱码放入 \`=== 异常词汇 ===\`；用户指定释义优先。
4. **例句（高频实用）**：优先日常口语搭配（如动介/名介），冠词须体现格（Kasus），拒绝无语境单句。

# Field Schema

- **名词 (N)**（还原单数）：
  - F1: \`名词/复合词，[中文]，[英文]\`
  - F2: \`[der/die/das] [单数原型] pl.[完整复数]\` (无复数写 \`pl.-\`)
  - F3: \`[挖空例句] ([中文翻译])\` (仅挖空单数原型)

- **动词 (V)**（仅 \`sich\`+单动词）：
  - F1: \`v.，[中文]，[英文]\`
  - F2: \`[原型]，[3单过去时]，[过去分词] [h/s]\` (可分动词用 \`/\` 分割原型)
  - F3: \`[挖空例句] ([中文翻译])\` (可分动词挖空词根与前缀；使用现在时)

- **形容词/副词/短语 (Adj./Adv./Phr.)**（含介词/接格占位符如 \`etw.(A)\` 一律算 phr.）：
  - F1: \`adj./adv./phr.，[中文]，[英文]\`
  - F2: \`[标准化原型]\`
  - F3: \`[挖空例句] ([中文翻译])\` (短语挖空核心动词与介词)

# Few-Shot Examples

输入：
常规：
Bücher
apfel
sich an etwasA halten
xyzqwe

tgs：
Schule

输出：
=== 常规 ===
名词，书，book | das Buch pl.Bücher | Ich lese gerade ein spannendes ___. (我正在读一本精彩的书。)
名词，苹果，apple | der Apfel pl.Äpfel | Er beißt herzlich in den ___. (他狠狠地咬了一口苹果。)
phr.，遵守，坚持，stick to, adhere to | sich an etw.(A) halten | Er ___ ___ die Regeln. (他遵守规则。)
=== tgs ===
名词，学校，school | die Schule pl.Schulen | Die Kinder gehen morgens in die ___. (孩子们早上去学校。)
=== 异常词汇 ===
xyzqwe`

export function getCachedAnkiPrompt() {
  const custom = getAnkiSettings().prompt
  if (custom) return custom
  return DEFAULT_PROMPT
}

export function loadAnkiPrompt() {
  const custom = getAnkiSettings().prompt
  if (custom) {
    DBG('anki:prompt:effective', { source: 'custom', length: custom.length })
    return Promise.resolve(custom)
  }
  DBG('anki:prompt:effective', { source: 'builtin', length: DEFAULT_PROMPT.length })
  if (!DEFAULT_PROMPT) {
    return Promise.resolve('')
  }
  return Promise.resolve(DEFAULT_PROMPT)
}

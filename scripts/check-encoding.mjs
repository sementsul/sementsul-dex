// Найти повреждённые символы (U+FFFD) в текстовых файлах проекта.
//
// Повреждения появляются, когда текст проходит через консольные инструменты
// с неверной кодовой страницей. В коде это не ошибка сборки, но в интерфейсе
// пользователь увидит ромбик вместо буквы.

import { readFileSync, existsSync } from 'node:fs'

const FILES = [
  'README.md',
  'src/App.jsx',
  'src/styles.css',
  'src/lib/chain.js',
  'src/lib/abi.js',
  'src/lib/liquidity.js',
  'src/lib/knowledge.js',
  'src/components/PoolsPage.jsx',
  'src/components/CreatePool.jsx',
  'src/components/LiquidityPanel.jsx',
  'src/components/KnowledgePage.jsx',
  'scripts/check-tokens.mjs',
  'scripts/test-knowledge.mjs',
]

const BAD = '\uFFFD'
let found = 0

for (const f of FILES) {
  if (!existsSync(f)) {
    console.log('нет файла:', f)
    continue
  }
  const text = readFileSync(f, 'utf8')
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    const at = line.indexOf(BAD)
    if (at >= 0) {
      console.log(`${f}:${i + 1}  ${line.slice(Math.max(0, at - 30), at + 30).trim()}`)
      found++
    }
  })
}

console.log(found === 0 ? 'повреждённых символов нет' : `найдено повреждений: ${found}`)
process.exit(found === 0 ? 0 : 1)
// Найти импорты, которые нигде не используются.
//
// Не ошибка сборки, но мусор в коде: тянет лишние модули в бандл и путает
// при чтении. Проверяем по числу вхождений имени в файле — одно вхождение
// означает только сам импорт.

import { readFileSync, existsSync } from 'node:fs'

const FILES = [
  'src/components/PoolsPage.jsx',
  'src/components/CreatePool.jsx',
  'src/components/LiquidityPanel.jsx',
  'src/components/KnowledgePage.jsx',
  'src/App.jsx',
  'src/lib/liquidity.js',
  'src/lib/knowledge.js',
]

let found = 0

for (const f of FILES) {
  if (!existsSync(f)) {
    console.log('нет файла:', f)
    continue
  }
  const src = readFileSync(f, 'utf8')

  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"][^'"]+['"]/g)) {
    for (const raw of m[1].split(',')) {
      const parts = raw.trim().split(/\s+as\s+/)
      const local = (parts[1] ?? parts[0] ?? '').trim()
      if (!local) continue

      // Считаем вхождения как отдельного слова, исключая строку импорта.
      const withoutImport = src.replace(m[0], '')
      const re = new RegExp(`\\b${local.replace(/\$/g, '\\$')}\\b`, 'g')
      const hits = (withoutImport.match(re) ?? []).length
      if (hits === 0) {
        console.log(`НЕ ИСПОЛЬЗУЕТСЯ  ${f}: ${local}`)
        found++
      }
    }
  }
}

console.log(found === 0 ? 'неиспользуемых импортов нет' : `найдено: ${found}`)
process.exit(found === 0 ? 0 : 1)
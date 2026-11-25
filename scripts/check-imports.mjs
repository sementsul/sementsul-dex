// Проверить, что все импортируемые символы реально экспортируются.
//
// Vite сборка падает только при полном отсутствии файла; при отсутствии
// именованного экспорта она тоже падает, но сообщение бывает невнятным.
// Этот скрипт называет точную пару «файл → символ».

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const FILES = [
  'src/components/PoolsPage.jsx',
  'src/components/CreatePool.jsx',
  'src/components/LiquidityPanel.jsx',
  'src/components/KnowledgePage.jsx',
  'src/App.jsx',
  'src/lib/liquidity.js',
]

// Собираем экспорты каждого модуля: имя → true.
const exportCache = new Map()

function exportsOf(path) {
  if (exportCache.has(path)) return exportCache.get(path)
  if (!existsSync(path)) {
    exportCache.set(path, null)
    return null
  }
  const src = readFileSync(path, 'utf8')
  const names = new Set()

  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1])
  }
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const t = part.trim()
      if (!t) continue
      const asMatch = t.match(/\bas\s+([A-Za-z_$][\w$]*)$/)
      names.add(asMatch ? asMatch[1] : t.split(/\s+/)[0])
    }
  }
  if (/export\s+default/.test(src)) names.add('default')

  exportCache.set(path, names)
  return names
}

let problems = 0

for (const f of FILES) {
  if (!existsSync(f)) {
    console.log('нет файла:', f)
    continue
  }
  const src = readFileSync(f, 'utf8')
  const dir = dirname(f)

  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean)
    const spec = m[2]
    if (!spec.startsWith('.')) continue

    let target = resolve(dir, spec)
    const candidates = [target, target + '.js', target + '.jsx', join(target, 'index.js')]
    const found = candidates.find((c) => existsSync(c))
    if (!found) {
      console.log(`НЕТ ФАЙЛА  ${f} -> ${spec}`)
      problems++
      continue
    }

    const ex = exportsOf(found)
    for (const n of names) {
      if (!ex || !ex.has(n)) {
        console.log(`НЕТ ЭКСПОРТА  ${f}: ${n} из ${spec}`)
        problems++
      }
    }
  }
}

console.log(problems === 0 ? 'все импорты разрешаются' : `проблем: ${problems}`)
process.exit(problems === 0 ? 0 : 1)
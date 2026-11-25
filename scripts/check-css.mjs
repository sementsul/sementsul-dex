// Найти CSS-классы, которые компоненты используют, но в styles.css их нет.
// Нужен, чтобы не выпустить экран с неоформленными элементами: в CSS это не
// ошибка сборки, поэтому Vite молча соберёт «голую» страницу.

import { readFileSync, existsSync } from 'node:fs'

const css = readFileSync('src/styles.css', 'utf8')
const existing = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))

const files = [
  'src/components/PoolsPage.jsx',
  'src/components/CreatePool.jsx',
  'src/components/LiquidityPanel.jsx',
  'src/components/KnowledgePage.jsx',
  'src/App.jsx',
]
const used = new Set()

for (const f of files) {
  if (!existsSync(f)) {
    console.log('нет файла:', f)
    continue
  }
  const text = readFileSync(f, 'utf8')
  // className="a b c" и className={...} — берём обе формы, затем режем по
  // всему, что не похоже на имя класса.
  for (const m of text.matchAll(/className=(?:"([^"]*)"|\{([^}]*)\})/g)) {
    const raw = (m[1] ?? m[2] ?? '').replace(/['"`]/g, ' ')
    for (const tok of raw.split(/[^a-zA-Z0-9_-]+/)) {
      if (tok && /^[a-z]/.test(tok)) used.add(tok)
    }
  }
}

const missing = [...used].filter((x) => !existing.has(x)).sort()
console.log('используется классов:', used.size)
console.log('отсутствует в styles.css:', missing.length)
if (missing.length) console.log(missing.join('\n'))
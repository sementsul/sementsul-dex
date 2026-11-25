// Починить строку с повреждённым символом в тестовом файле.
//
// Аргументом такую строку не передать: сам символ U+FFFD при наборе теряется.
// Поэтому заменяем по номеру строки.

import { readFileSync, writeFileSync } from 'node:fs'

const path = 'test/V2Invariant.t.sol'
const lines = readFileSync(path, 'utf8').split('\n')

const fixed = '    /// первый LP не может выкупить весь пул и оставить его без ликвидности.'
let count = 0

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('\uFFFD')) {
    lines[i] = fixed
    count++
  }
}

writeFileSync(path, lines.join('\n'), 'utf8')
console.log('исправлено строк:', count)
console.log('осталось повреждённых:', lines.filter((l) => l.includes('\uFFFD')).length)
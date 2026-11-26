// Точечное извлечение контекста из минифицированного бандла.
//
// Бандл — одна строка на 4 МБ, поэтому grep печатает целиком её и заваливает
// вывод. Здесь находим позицию и печатаем небольшое окно вокруг.
//
// Использование: node scripts/peek.mjs <файл> <шаблон> [окно]

import { readFileSync } from 'node:fs'

const file = process.argv[2]
const pattern = process.argv[3]
const win = Number(process.argv[4] ?? 300)
const limit = Number(process.argv[5] ?? 6)

const src = readFileSync(file, 'utf8')
const re = new RegExp(pattern, 'g')

let m
let n = 0
while ((m = re.exec(src)) && n < limit) {
  const start = Math.max(0, m.index - win)
  const end = Math.min(src.length, m.index + m[0].length + win)
  const before = src.slice(start, m.index).replace(/\s+/g, ' ')
  const found = m[0]
  const after = src.slice(m.index + m[0].length, end).replace(/\s+/g, ' ')
  console.log(`--- вхождение ${n + 1} на позиции ${m.index} ---`)
  console.log('...' + before + '【' + found + '】' + after + '...')
  console.log('')
  n++
}

if (n === 0) console.log('не найдено')
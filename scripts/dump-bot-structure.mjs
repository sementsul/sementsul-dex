// Извлечение структуры бота: таблицы D1, функции, ключевые параметры.

import fs from 'node:fs'

const b = fs.readFileSync('_worker-dump/lp-ladder.js', 'utf8')

console.log('=== таблицы D1 ===')
const tables = [...b.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map((m) => m[1])
console.log(tables.join(', '))
console.log('')

console.log('=== схема positions ===')
const i = b.indexOf('CREATE TABLE IF NOT EXISTS positions')
console.log(b.slice(i, i + 400).split('\n').slice(0, 14).join('\n'))
console.log('')

console.log('=== функции (__name) ===')
const names = new Set()
for (const m of b.matchAll(/__name\(([\w$]+), "([\w$]+)"\)/g)) names.add(m[2])
console.log([...names].sort().join(', '))
console.log('')

console.log('=== перем. окружения ===')
const envs = new Set()
for (const m of b.matchAll(/env2\.([A-Z_][A-Z0-9_]*)/g)) envs.add(m[1])
console.log([...envs].sort().join(', '))
console.log('')

console.log('=== ADDR ===')
const a = b.indexOf('var ADDR = {')
console.log(b.slice(a, b.indexOf('};', a) + 2))
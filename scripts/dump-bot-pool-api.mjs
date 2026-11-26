// Что именно бот читает и пишет в пул: его ABI и вызовы.

import fs from 'node:fs'

const b = fs.readFileSync('_worker-dump/lp-ladder.js', 'utf8')

// Ищем секцию abi2.pool
const i = b.indexOf('pool: [')
console.log('=== ABI пула у бота ===')
console.log(b.slice(i, b.indexOf(']', b.indexOf('positions', i)) + 1).slice(0, 2000))
console.log('')

// Ищем readPosition
for (const name of ['readPosition', 'poolState', 'mintPosition', 'burnPosition']) {
  const idx = b.indexOf(`function ${name}(`)
  const idx2 = b.indexOf(`async ${name}(`)
  const at = idx >= 0 ? idx : idx2
  if (at < 0) { console.log(`--- ${name}: нет ---\n`); continue }
  const marker = `__name(${name}, "${name}")`
  const end = b.indexOf(marker, at)
  console.log(`--- ${name} ---`)
  console.log(b.slice(at, end > 0 ? end + marker.length : at + 900).slice(0, 1400))
  console.log('')
}
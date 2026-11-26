// Где именно используется POOL (из POOL_ADDRESS) в отличие от REF_POOL и ADDR.npm.

import fs from 'node:fs'

const b = fs.readFileSync('_worker-dump/lp-ladder.js', 'utf8')

// Берём срез кода цепочки (makeChain) и смотрим все упоминания POOL/REF_POOL/npm/v3router
const start = b.indexOf('function makeChain(env2)')
const end = b.indexOf('var ADDR', start) > 0 ? b.indexOf('var ADDR', start) : start + 30000
const seg = b.slice(start, Math.min(start + 8000, b.length))

console.log('=== начало makeChain ===')
console.log(seg.slice(0, 1600))
console.log('')

console.log('=== все упоминания POOL (не REF_POOL, не POOL_FEE) ===')
const re = /(?<!REF_)(?<!_)POOL(?!_ADDRESS|_FEE|S\b)/g
let m, n = 0
while ((m = re.exec(b)) !== null && n < 25) {
  n++
  const ctx = b.slice(Math.max(0, m.index - 100), m.index + 120).replace(/\n/g, ' ⏎ ')
  console.log(`  [${m.index}] …${ctx}…`)
}
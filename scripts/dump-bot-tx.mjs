// Тела mintPosition, increase, decrease, collect, burn, swapV3 и как
// используется POOL_ADDRESS.

import fs from 'node:fs'

const b = fs.readFileSync('_worker-dump/lp-ladder.js', 'utf8')

const want = ['mintPosition', 'increase', 'decrease', 'collect', 'burn', 'swapV3', 'buildPosition']

for (const name of want) {
  // Объявления вида: const name = /* @__PURE__ */ __name(async (...) => {
  const pat1 = `const ${name} = /* @__PURE__ */ __name(`
  const i1 = b.indexOf(pat1)
  const i2 = b.indexOf(`const ${name} = `)
  const at = i1 >= 0 ? i1 : i2
  if (at < 0) { console.log(`--- ${name}: нет ---\n`); continue }
  const marker = `}, "${name}");`
  const end = b.indexOf(marker, at)
  const body = end > 0 ? b.slice(at, end + marker.length) : b.slice(at, at + 700)
  console.log(`--- ${name} ---`)
  console.log(body.slice(0, 900))
  console.log('')
}

console.log('=== POOL_ADDRESS ===')
let idx = -1, n = 0
while ((idx = b.indexOf('POOL_ADDRESS', idx + 1)) !== -1 && n < 5) {
  n++
  console.log(`  …${b.slice(Math.max(0, idx - 110), idx + 110).replace(/\n/g, ' ⏎ ')}…`)
}
// ABI роутера V3 у бота и логика выбора маршрута.

import fs from 'node:fs'

const b = fs.readFileSync('_worker-dump/lp-ladder.js', 'utf8')

const i = b.indexOf('v3router: [')
console.log('=== abi2.v3router ===')
console.log(b.slice(i, i + 900))
console.log('')

// swapBest — как выбирается маршрут
const j = b.indexOf('const swapBest = /* @__PURE__ */ __name(')
if (j > 0) {
  console.log('=== swapBest ===')
  console.log(b.slice(j, j + 1100))
}
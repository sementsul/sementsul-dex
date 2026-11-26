// Ищем в боте места, где читается slot0 и позиции, и как называются обёртки.

import fs from 'node:fs'

const b = fs.readFileSync('_worker-dump/lp-ladder.js', 'utf8')

for (const needle of ['slot0', 'readPosition', 'tokenOfOwnerByIndex', 'positions(']) {
  console.log(`=== вхождения "${needle}" ===`)
  let idx = -1, n = 0
  while ((idx = b.indexOf(needle, idx + 1)) !== -1 && n < 6) {
    n++
    const line = b.slice(Math.max(0, idx - 90), idx + 130).replace(/\n/g, ' ⏎ ')
    console.log(`  [${idx}] …${line}…`)
  }
  console.log('')
}
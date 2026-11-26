// Проверка: в подвале не должно остаться ссылки на PancakeSwap.
// Приватный RPC и CDN логотипов — не ссылки для пользователя, они нужны.

import fs from 'node:fs'

const bundle = process.argv[2] ?? 'dist/assets/index-DOA22iGg.js'
const b = fs.readFileSync(bundle, 'utf8')

const anchor = 'href:"https://pancakeswap.finance"'
const bscscan = 'href:"https://bscscan.com"'

const checks = [
  ['ссылки на PancakeSwap в подвале нет', !b.includes(anchor)],
  ['ссылка на BscScan осталась', b.includes(bscscan)],
  ['приватный RPC на месте', b.includes('bscrpc.pancakeswap.finance')],
  ['CDN логотипов на месте', b.includes('tokens.pancakeswap.finance')],
]

let bad = 0
for (const [name, ok] of checks) {
  if (!ok) bad++
  console.log((ok ? '  ok  ' : 'ФЕЙЛ  ') + name)
}
console.log('')
console.log(bad === 0 ? 'всё верно' : `проблем: ${bad}`)
process.exit(bad === 0 ? 0 : 1)
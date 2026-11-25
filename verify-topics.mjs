// Проверка, что разбор логов отсеивает посторонние события пары.
//
// Зачем: публичный RPC publicnode отвергает непустой topics как Invalid params
// и возвращает ВСЕ события адреса — Swap, Sync, Transfer, Mint, Burn, Approval.
// У Sync и Transfer тоже по 4 слова в data, поэтому без явной проверки topic0
// они пройдут разбор как сделки и запишут в базу мусорные цены.
//
// Скрипт берёт реальные логи живой пары и убеждается, что после разбора
// остаются только Swap.

import { parseSwapV2, TOPIC_SWAP_V2 } from './worker/logic.js'

let pass = 0
let fail = 0
function check(label, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`OK   ${label} ${extra}`)
  } else {
    fail++
    console.log(`FAIL ${label} ${extra}`)
  }
}

const RPC = 'https://bsc-rpc.publicnode.com'
const PAIR = '0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae' // WBNB/USDT V2, самая активная

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await res.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}

const head = Number(BigInt(await rpc('eth_blockNumber', [])))
// 400 блоков ≈ 3 минуты: гарантированно есть и Swap, и Sync.
const from = head - 400

console.log(`=== логи пары ${PAIR} ===`)
console.log(`блоки ${from}..${head}`)

// Без topics — ровно так, как их отдаёт publicnode.
const logs = await rpc('eth_getLogs', [
  {
    address: PAIR,
    fromBlock: '0x' + from.toString(16),
    toBlock: '0x' + head.toString(16),
  },
])

check('логи получены', logs.length > 0, `${logs.length} шт.`)

// Считаем фактическое распределение по темам.
const byTopic = new Map()
for (const l of logs) {
  const t = l.topics[0]
  byTopic.set(t, (byTopic.get(t) ?? 0) + 1)
}
console.log('\nраспределение событий по темам:')
for (const [t, n] of [...byTopic].sort((a, b) => b[1] - a[1])) {
  const mark = t === TOPIC_SWAP_V2 ? '  <- Swap' : ''
  console.log(`  ${t.slice(0, 12)}…  ${String(n).padStart(4)}${mark}`)
}

const swapCount = byTopic.get(TOPIC_SWAP_V2) ?? 0
check('среди логов есть Swap', swapCount > 0, `${swapCount} шт.`)
check('среди логов есть посторонние события', byTopic.size > 1, `типов: ${byTopic.size}`)

// Ключевая проверка: разбор возвращает ровно столько же сделок, сколько Swap-событий.
const parsed = logs.map(parseSwapV2).filter(Boolean)
check(
  'разбор вернул только Swap, ничего лишнего',
  parsed.length === swapCount,
  `разобрано ${parsed.length}, Swap в логах ${swapCount}`
)
check('ни одно постороннее событие не прошло', parsed.length <= swapCount)

// И обратная проверка: подсунуть событие с чужой темой и правдоподобным data.
console.log('\n=== подмена темы ===')
const foreign = {
  ...logs.find((l) => l.topics[0] !== TOPIC_SWAP_V2),
  data: '0x' + '0'.repeat(63) + '1' + '0'.repeat(63) + '2' + '0'.repeat(63) + '3' + '0'.repeat(63) + '4',
}
check('событие с чужой темой отброшено', parseSwapV2(foreign) === null, `тема ${foreign.topics[0].slice(0, 12)}…`)

// И событие вовсе без тем.
const noTopics = { ...foreign, topics: [] }
check('событие без тем отброшено', parseSwapV2(noTopics) === null)

// И корректный Swap с подставленной темой — принимается (контроль, что фильтр
// не отбрасывает всё подряд).
const realSwap = logs.find((l) => l.topics[0] === TOPIC_SWAP_V2)
check('настоящий Swap принимается', parseSwapV2(realSwap) !== null)

// Регистр темы не должен влиять.
const upper = { ...realSwap, topics: [realSwap.topics[0].toUpperCase(), ...realSwap.topics.slice(1)] }
check('тема в верхнем регистре принимается', parseSwapV2(upper) !== null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
// Проверка, что eth_getBlockReceipts даёт те же Swap-логи, что eth_getLogs.
//
// Зачем: из Cloudflare Workers eth_getLogs недоступен (публичные BSC-RPC
// троттлят общие egress-IP Cloudflare). Индексатор переведён на
// eth_getBlockReceipts, и нужно убедиться, что это не меняет результат:
// обход по блокам должен находить ровно те же события пары.
//
// Сравнение идёт на живой паре WBNB/USDT, где getLogs ещё работает из обычного IP.

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
const PAIR = '0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae' // WBNB/USDT V2

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const j = await res.json()
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}

const head = Number(BigInt(await rpc('eth_blockNumber', [])))
const SPAN = 60
const from = head - SPAN

console.log(`=== блоки ${from}..${head} (${SPAN} шт.) ===\n`)

// --- путь 1: getLogs по диапазону (как было раньше) ---
const viaGetLogs = await rpc('eth_getLogs', [
  {
    address: PAIR,
    fromBlock: '0x' + from.toString(16),
    toBlock: '0x' + head.toString(16),
  },
])
const swapsA = viaGetLogs.filter((l) => l.topics[0] === TOPIC_SWAP_V2)
console.log(`getLogs:            ${viaGetLogs.length} логов, из них Swap ${swapsA.length}`)

// --- путь 2: blockReceipts по одному блоку (как сейчас) ---
const viaReceipts = []
for (let n = from; n <= head; n++) {
  const receipts = await rpc('eth_getBlockReceipts', ['0x' + n.toString(16)])
  if (!Array.isArray(receipts)) continue
  for (const r of receipts) {
    for (const log of r?.logs ?? []) {
      if (log.address?.toLowerCase() === PAIR) viaReceipts.push(log)
    }
  }
}
const swapsB = viaReceipts.filter((l) => l.topics[0] === TOPIC_SWAP_V2)
console.log(`blockReceipts:      ${viaReceipts.length} логов, из них Swap ${swapsB.length}\n`)

// --- сравнение ---
const key = (l) => `${l.transactionHash}:${l.logIndex}`
const setA = new Set(swapsA.map(key))
const setB = new Set(swapsB.map(key))

check('оба способа нашли Swap', swapsA.length > 0 && swapsB.length > 0, `${swapsA.length} / ${swapsB.length}`)
check('количество Swap совпадает', setA.size === setB.size, `${setA.size} vs ${setB.size}`)

const missingFromB = [...setA].filter((k) => !setB.has(k))
const extraInB = [...setB].filter((k) => !setA.has(k))
check('ни один Swap не потерян', missingFromB.length === 0, missingFromB.slice(0, 3).join(', '))
check('нет лишних Swap', extraInB.length === 0, extraInB.slice(0, 3).join(', '))

// Разбор должен дать одинаковый результат на обоих наборах.
const parsedA = swapsA.map(parseSwapV2).filter(Boolean)
const parsedB = swapsB.map(parseSwapV2).filter(Boolean)
check('разбор даёт одинаковое число сделок', parsedA.length === parsedB.length, `${parsedA.length} vs ${parsedB.length}`)

// Побайтовая сверка цен: именно они попадут в базу.
let priceMismatch = 0
for (let i = 0; i < Math.min(parsedA.length, parsedB.length); i++) {
  if (parsedA[i].price !== parsedB[i].price) priceMismatch++
}
check('цены совпадают полностью', priceMismatch === 0, `расхождений: ${priceMismatch}`)

// --- проверка фильтра по адресу ---
// blockReceipts отдаёт логи ВСЕХ контрактов, поэтому фильтр по адресу пары
// обязателен: иначе в базу попали бы Swap-события чужих пулов.
const allLogs = []
const receiptsOne = await rpc('eth_getBlockReceipts', ['0x' + head.toString(16)])
for (const r of receiptsOne ?? []) for (const l of r?.logs ?? []) allLogs.push(l)
const foreign = allLogs.filter((l) => l.address?.toLowerCase() !== PAIR)
check('в блоке есть логи других контрактов', foreign.length > 0, `${foreign.length} шт.`)
check('фильтр по адресу отсекает их', allLogs.length - foreign.length === allLogs.filter((l) => l.address?.toLowerCase() === PAIR).length)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
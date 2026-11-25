// Проверка парсинга Swap-логов на РЕАЛЬНЫХ событиях из сети.
// Импортирует тот же parseSwapV2, что работает в воркере — тест не может
// разойтись с продакшн-кодом.
// Запуск: node verify-worker.mjs

import { parseSwapV2, aggregateCandles } from './worker/logic.js'

const RPC = 'https://bsc-rpc.publicnode.com'
const TOPIC_SWAP_V2 = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'

const PAIRS = {
  'WBNB/USDT-V2': '0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae',
  'CAKE/WBNB-V2': '0x0ed7e52944161450477ee417de9cd3a859b14fd0',
}

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

const latest = Number(BigInt(await rpc('eth_blockNumber', [])))
console.log('последний блок:', latest)

let sawFlash = false

for (const [name, pair] of Object.entries(PAIRS)) {
  console.log(`\n=== ${name} (${pair}) ===`)

  let logs = []
  let from = latest
  for (let attempt = 0; attempt < 6 && logs.length === 0; attempt++) {
    const start = from - 35000
    logs = await rpc('eth_getLogs', [
      {
        address: pair,
        topics: [TOPIC_SWAP_V2],
        fromBlock: '0x' + Math.max(0, start).toString(16),
        toBlock: '0x' + from.toString(16),
      },
    ])
    console.log(`  окно ${start}..${from}: ${logs.length} событий`)
    from = start
  }

  if (logs.length === 0) {
    console.log('  (событий не найдено)')
    continue
  }

  const parsed = logs.map(parseSwapV2).filter(Boolean)
  check(`${name}: все логи разобраны`, parsed.length === logs.length, `${parsed.length}/${logs.length}`)

  const swaps = parsed.filter((p) => p.kind === 'swap')
  const flash = parsed.filter((p) => p.kind === 'flash')
  console.log(`  обычных свопов: ${swaps.length}, flash: ${flash.length}`)
  if (flash.length) sawFlash = true

  // ГЛАВНЫЙ инвариант: у обычного свопа вход и выход — в РАЗНЫХ токенах,
  // и цена строго положительна.
  const badPrice = swaps.filter((p) => p.price <= 0n)
  check(`${name}: у всех свопов цена > 0`, badPrice.length === 0, `нулевых ${badPrice.length}`)

  const badAmounts = swaps.filter((p) => p.amountIn <= 0n || p.amountOut <= 0n)
  check(`${name}: суммы положительны`, badAmounts.length === 0, `плохих ${badAmounts.length}`)

  // У flash-свопов цена обязана быть 0 — их нельзя использовать для графика.
  const badFlash = flash.filter((p) => p.price !== 0n)
  check(`${name}: у flash-свопов цена обнулена`, badFlash.length === 0, `плохих ${badFlash.length}`)

  // Цена не должна быть абсурдной: сравниваем с порядком величины медианы.
  if (swaps.length > 10) {
    const prices = swaps.map((p) => Number(p.price) / 1e18).sort((a, b) => a - b)
    const median = prices[Math.floor(prices.length / 2)]
    const outliers = prices.filter((x) => x > median * 50 || x < median / 50)
    check(`${name}: выбросов цены < 1%`, outliers.length / prices.length < 0.01,
      `${outliers.length}/${prices.length}`)
    console.log(`  медиана ${median.toExponential(4)}, диапазон ${prices[0].toExponential(3)}..${prices[prices.length - 1].toExponential(3)}`)
  }

  const sample = logs[0]
  const block = await rpc('eth_getBlockByNumber', [sample.blockNumber, false])
  const ts = Number(BigInt(block.timestamp))
  const now = Math.floor(Date.now() / 1000)
  check(`${name}: время блока адекватно`, ts > 1_600_000_000 && ts <= now + 120, `ts=${ts}`)
}

check('видели хотя бы один flash-своп (парсер их распознаёт)', sawFlash)

// ---------- агрегация свечей ----------

console.log('\n=== агрегация свечей ===')
{
  // Цены в БД лежат строкой/BigInt в масштабе 1e18 — тест подаёт ровно такой формат.
  const S = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n
  const bucket = 300
  const trades = [
    { ts: 1000, price: S(10) },
    { ts: 1010, price: S(12) },
    { ts: 1290, price: S(8) },
    { ts: 1300, price: S(15) },
  ]
  const candles = aggregateCandles(trades, bucket)
  check('бакетов получилось 2', candles.length === 2, `-> ${candles.length}`)
  // 1000 и 1010 -> бакет 900; 1290 и 1300 -> бакет 1200.
  check('время первого бакета = 900', candles[0].time === 900, `-> ${candles[0].time}`)
  check('open первого бакета = 10', candles[0].open === 10, `-> ${candles[0].open}`)
  check('high первого бакета = 12', candles[0].high === 12, `-> ${candles[0].high}`)
  check('low первого бакета = 10', candles[0].low === 10, `-> ${candles[0].low}`)
  check('close первого бакета = 12', candles[0].close === 12, `-> ${candles[0].close}`)
  check('время второго бакета = 1200', candles[1].time === 1200, `-> ${candles[1].time}`)
  check('open второго бакета = 8', candles[1].open === 8, `-> ${candles[1].open}`)
  check('close второго бакета = 15', candles[1].close === 15, `-> ${candles[1].close}`)
  check('свечи по возрастанию времени', candles[0].time < candles[1].time)
}

// Сделки вне порядка не должны ломать open/close
console.log('\n=== устойчивость к порядку ===')
{
  const S = (n) => BigInt(n) * 10n ** 18n
  const bucket = 60
  const shuffled = [
    { ts: 100, price: S(5) },
    { ts: 90, price: S(3) }, // раньше по времени, но позже в массиве
    { ts: 110, price: S(7) },
  ]
  const candles = aggregateCandles(shuffled, bucket)
  check('open = самая ранняя по времени (3)', candles[0].open === 3, `-> ${candles[0].open}`)
  check('close = самая поздняя по времени (7)', candles[0].close === 7, `-> ${candles[0].close}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
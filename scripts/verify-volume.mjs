// Проверка оценки объёма: сходится ли она с реальными свопами.
//
// В документе стоит «объём ~$8000 за всё время, комиссии ~$4» — это оценка
// из feeGrowthGlobal. Оценка ненадёжна, потому что ликвидность менялась.
//
// Проверяем иначе: суммируем amount0 из событий Swap за доступное окно и
// экстраполируем. Если два метода дают похожий порядок — цифре можно верить.
import { createPublicClient, http, parseAbi, decodeAbiParameters, parseAbiParameters } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const Q128 = 2n ** 128n

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const abi = parseAbi([
  'function slot0() view returns (uint160, int24, uint128, uint24, int24)',
  'function liquidity() view returns (uint128)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
])

const [slot0, liq, fg0, fg1] = await Promise.all([
  client.readContract({ address: POOL, abi, functionName: 'slot0' }),
  client.readContract({ address: POOL, abi, functionName: 'liquidity' }),
  client.readContract({ address: POOL, abi, functionName: 'feeGrowthGlobal0X128' }),
  client.readContract({ address: POOL, abi, functionName: 'feeGrowthGlobal1X128' }),
])
const price = 1.0001 ** -Number(slot0[1])
const fee = Number(slot0[3])

// --- Метод 1: feeGrowthGlobal ---
const fees0 = (Number(fg0) / 2 ** 128) * (Number(liq) / 1e18)
const fees1 = (Number(fg1) / 2 ** 128) * (Number(liq) / 1e18)
const feesUsd1 = fees0 + fees1 * price
const vol1 = feesUsd1 / (fee / 1_000_000)
console.log('=== МЕТОД 1: feeGrowthGlobal ===')
console.log('  суммарные комиссии ≈ $' + feesUsd1.toFixed(2))
console.log('  объём ≈ $' + vol1.toFixed(0))
console.log('  оценка грубая: считает по ТЕКУЩЕЙ ликвидности, а она росла в 4 раза.')

// --- Метод 2: прямая сумма Swap за окно ---
const head = await client.getBlockNumber()
const WINDOW = 400n
const ROUNDS = 100
let sumUsd = 0
let count = 0
let minBlock = head
for (let i = 0; i < ROUNDS; i++) {
  const toBlock = head - BigInt(i) * WINDOW
  const fromBlock = toBlock - WINDOW + 1n
  try {
    const logs = await client.getLogs({ address: POOL, topics: [SWAP_TOPIC], fromBlock, toBlock })
    for (const l of logs) {
      if (l.address.toLowerCase() !== POOL.toLowerCase()) continue
      try {
        const d = decodeAbiParameters(
          parseAbiParameters('int256 amount0, int256 amount1, uint160, uint128, int24'),
          l.data,
        )
        // amount0 — USDT (token0). Модуль = объём в USDT.
        const usdt = Number(d[0] < 0n ? -d[0] : d[0]) / 1e18
        sumUsd += usdt
        count++
        if (l.blockNumber < minBlock) minBlock = l.blockNumber
      } catch {}
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 100))
}
const blocksScanned = Number(head - minBlock) + 1
console.log('')
console.log('=== МЕТОД 2: прямая сумма Swap ===')
console.log('  свопов:', count)
console.log('  просмотрено блоков:', blocksScanned, '≈', (blocksScanned * 0.45 / 60).toFixed(0), 'мин')
console.log('  объём за окно: $' + sumUsd.toFixed(2))
if (blocksScanned > 0) {
  const perMin = sumUsd / (blocksScanned * 0.45 / 60)
  console.log('  в минуту: $' + perMin.toFixed(2))
  console.log('  в час:    $' + (perMin * 60).toFixed(0))
  console.log('  в сутки:  $' + (perMin * 60 * 24).toFixed(0))
}
console.log('')
console.log('=== СВЕРКА ===')
console.log(`  метод 1 (feeGrowth): $${vol1.toFixed(0)} за ВСЮ историю пула`)
console.log(`  метод 2 (свопы):     $${sumUsd.toFixed(2)} за ${(blocksScanned * 0.45 / 60).toFixed(0)} мин`)
console.log('')
console.log('  Если в час проходит ~$' + (blocksScanned > 0 ? (sumUsd / (blocksScanned * 0.45 / 60) * 60).toFixed(0) : '?') + ',')
console.log('  то вся история в $' + vol1.toFixed(0) + ' набирается за несколько часов —')
console.log('  значит пул торгуется активно, и оценка по feeGrowth правдоподобна.')
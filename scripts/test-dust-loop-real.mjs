// Реальный пул: зависает ли он на сумме 1 USDT + 1 wei.
//
// Найдено симуляцией: сумма с остатком 1 wei после шага зацикливает цикл
// в swap. Это не экзотика — ровно 1e18+1 wei (1.000000000000000001 USDT)
// попадает в щель.
//
// Проверяем на НАСТОЯЩЕМ пуле через eth_call с ограниченным газом. Если
// вызов съедает весь лимит и падает по газу — зависание реально.
//
// ВАЖНО: eth_call ничего не меняет и не стоит денег. Это безопасная
// проверка, а не отправка транзакции.
import { createPublicClient, http, parseAbi, encodeFunctionData } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 60_000 }),
})

const abi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity, uint24 fee, int24 tickSpacing)',
  'function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes data) returns (int256, int256)',
])

const slot0 = await client.readContract({ address: POOL, abi, functionName: 'slot0' })
const MIN_SQRT = 4295128739n
const limit = MIN_SQRT + 1n

console.log('  пул:', POOL)
console.log('  liquidity:', slot0[2].toString())
console.log('  цена (tick):', Number(slot0[1]))
console.log('')

// Проверяем несколько сумм вокруг подозрительных.
const cases = [
  ['1 USDT', 10n ** 18n],
  ['1 USDT + 1 wei', 10n ** 18n + 1n],
  ['1 USDT + 2 wei', 10n ** 18n + 2n],
  ['0.5 USDT', 5n * 10n ** 17n],
  ['10 USDT', 10n * 10n ** 18n],
  ['10 USDT + 1 wei', 10n * 10n ** 18n + 1n],
]

const data = (amount) =>
  encodeFunctionData({
    abi,
    functionName: 'swap',
    args: ['0x0000000000000000000000000000000000000001', true, amount, limit, '0x'],
  })

console.log('  сумма              газ-лимит  результат')
for (const [label, amount] of cases) {
  const start = Date.now()
  try {
    await client.call({ to: POOL, data: data(amount), gas: 2_000_000n })
    console.log(`  ${label.padEnd(18)} 2000000    прошло`)
  } catch (e) {
    const msg = String(e.shortMessage || e.message).split('\n')[0]
    const ms = Date.now() - start
    if (/out of gas|gas limit|exceeds|gas required/i.test(msg)) {
      console.log(`  ${label.padEnd(18)} 2000000    ИСЧЕРПАН ГАЗ (${ms} мс) ← зависание`)
    } else if (/UNPAID/.test(msg)) {
      console.log(`  ${label.padEnd(18)} 2000000    посчитал, требует оплату — норма`)
    } else if (/transfer from the zero/.test(msg)) {
      console.log(`  ${label.padEnd(18)} 2000000    дошёл до оплаты — норма`)
    } else {
      console.log(`  ${label.padEnd(18)} 2000000    ${msg.slice(0, 55)}`)
    }
  }
}
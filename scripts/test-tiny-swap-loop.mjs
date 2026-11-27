// Проверка: зацикливается ли наш пул на очень маленькой сумме обмена.
//
// Найдено тестом. При L ≈ 1e23 и сумме 1e6 wei цена за шаг не сдвигается
// ни на единицу uint160. В пуле цикл такой:
//
//     while (state.amountSpecifiedRemaining != 0 &&
//            state.sqrtPriceX96 != state.sqrtPriceLimitX96) { ... }
//
// Если цена не изменилась, а сумма осталась — условие не меняется, и цикл
// крутится вечно, пока не кончится газ (в тестах это MemoryOOG).
//
// ЭТО НЕ ОШИБКА КВОТЕРА. Квотер лишь вызвал swap, а swap завис.
// Вопрос в том, воспроизводится ли это на реальном пуле, где L в 40 раз
// больше, и какие суммы опасны.
//
// Проверяем через eth_call: настоящий пул, настоящие суммы. Если вызов
// съедает весь лимит газа — значит зависание реально.
import { createPublicClient, http, parseAbi, encodeFunctionData } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const abi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity, uint24 fee, int24 tickSpacing)',
  'function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes data) returns (int256, int256)',
])

const slot0 = await client.readContract({ address: POOL, abi, functionName: 'slot0' })
const sqrtP = slot0[0]
const L = slot0[2]
console.log('  пул:', POOL)
console.log('  liquidity:', L.toString())
console.log('  sqrtPriceX96:', sqrtP.toString())
console.log('')

const MIN_SQRT = 4295128739n
const limit = MIN_SQRT + 1n

// Суммы от ничтожной до заметной. Смотрим, какая проходит.
const amounts = [1000n, 10n ** 6n, 10n ** 9n, 10n ** 12n, 10n ** 15n, 10n ** 18n]

console.log('  сумма (wei)        результат eth_call')
for (const amount of amounts) {
  try {
    await client.call({
      to: POOL,
      data: encodeSwap(amount, limit),
      gas: 3_000_000n, // ограничиваем: зависание упрётся в этот лимит
    })
    console.log(`  ${amount.toString().padEnd(18)} прошло`)
  } catch (e) {
    const msg = String(e.shortMessage || e.message).split('\n')[0]
    if (/gas|limit|exceed/i.test(msg)) {
      console.log(`  ${amount.toString().padEnd(18)} ИСЧЕРПАЛ ГАЗ (похоже на зависание)`)
    } else if (/UNPAID/.test(msg)) {
      // UNPAID — правильный исход: swap посчитал и потребовал оплату.
      // Именно так и должен вести себя квотер.
      console.log(`  ${amount.toString().padEnd(18)} посчитал (UNPAID — норма для eth_call)`)
    } else {
      console.log(`  ${amount.toString().padEnd(18)} ${msg.slice(0, 60)}`)
    }
  }
}

function encodeSwap(amount, priceLimit) {
  return encodeFunctionData({
    abi,
    functionName: 'swap',
    args: ['0x0000000000000000000000000000000000000001', true, amount, priceLimit, '0x'],
  })
}
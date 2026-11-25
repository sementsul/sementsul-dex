// Проверка: что возвращает eth_estimateGas на разных RPC.
//
// Ошибка «transaction gas limit too high (cap: 16777216, tx: 28000000)»
// означает, что в транзакцию попал gas = 28 000 000. Приложение считает его
// как estimateGas * 1.2, значит оценка была ~23.3 млн — это больше лимита
// блока BSC (80 млн, но потолок RPC 16.7 млн на одну транзакцию).
//
// Такую оценку даёт нода, если вызов не ревертит, но и не может посчитать
// газ точно: некоторые ноды возвращают «весь блок» вместо ошибки.
//
// Скрипт показывает, что реально отдаёт каждая нода на один и тот же вызов.

import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'

const RPCS = [
  'https://bscrpc.pancakeswap.finance',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed1.defibit.io',
]

const { default: d } = await import('../src/contracts/deployments.js')

// Проверяем оценку газа на реальном вызове: добавление ликвидности в V2.
// Это самый «тяжёлый» путь в интерфейсе и самая вероятная причина ошибки.
const to = d.router
const data =
  '0xe8e33700' + // addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)
  d.wbnb.slice(2).padStart(64, '0') +
  d.token.slice(2).padStart(64, '0') +
  (10n ** 18n).toString(16).padStart(64, '0') +
  (10n ** 18n).toString(16).padStart(64, '0') +
  '0'.padStart(64, '0') +
  '0'.padStart(64, '0') +
  d.tokenRecipient.slice(2).padStart(64, '0') +
  (Math.floor(Date.now() / 1000) + 600).toString(16).padStart(64, '0')

console.log('=== eth_estimateGas по нодам ===\n')
console.log('вызов: addLiquidity в роутере', to)
console.log('отправитель:', d.tokenRecipient)
console.log('')

for (const url of RPCS) {
  const client = createPublicClient({ chain: bsc, transport: http(url) })
  try {
    const est = await client.estimateGas({
      account: d.tokenRecipient,
      to,
      data,
    })
    const withMargin = (est * 12n) / 10n
    const overCap = withMargin > 16777216n
    console.log(`${url}`)
    console.log(`  оценка:        ${est}`)
    console.log(`  с запасом 20%: ${withMargin}${overCap ? '  ← БОЛЬШЕ ПОТОЛКА 16777216' : ''}`)
  } catch (e) {
    console.log(`${url}`)
    console.log(`  ошибка: ${(e.shortMessage ?? e.message).slice(0, 140)}`)
  }
  console.log('')
}

console.log('потолок RPC на одну транзакцию: 16777216 (2^24)')
console.log('лимит газа блока BSC:          80000000')
// Когда появились позиции бота: читаем ликвидность пула на прошлых блоках.
//
// Баланс BNB у бота не изменился ни на вэй, хотя минт стоит газа. Значит либо
// позиции созданы раньше и другим подписантом, либо бот пополнялся. Чтобы не
// гадать, смотрим liquidity() на исторических блоках: активная ликвидность
// пула — это сумма позиций, перекрывающих текущий тик.
//
// node может не отдать состояние давних блоков, поэтому пробуем несколько
// точек и честно сообщаем, где данных нет.
import { createPublicClient, http, parseAbi, keccak256, encodePacked } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const BOT = '0x922598c9D529836b4b475cE74188D5EeFFb83a88'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const abi = parseAbi([
  'function liquidity() view returns (uint128)',
  'function positions(bytes32) view returns (uint128, uint256, uint256, uint128, uint128, uint128, uint128, uint256)',
])

const head = await client.getBlockNumber()
const MARK = {
  136030432: 'наш первый замер (до burn)',
  136033209: 'наш burn',
  136033217: 'наш transfer WBNB',
}
const POINTS = [136028000, 136030432, 136033209, 136033217, 136034000, Number(head) - 5, Number(head)]

console.log('  head =', head.toString())
console.log('')
console.log('  блок        активная ликвидность         отметка')
for (const b of POINTS) {
  try {
    const liq = await client.readContract({
      address: POOL, abi, functionName: 'liquidity', blockNumber: BigInt(b),
    })
    console.log(`  ${String(b).padEnd(11)} ${liq.toString().padEnd(26)} ${MARK[b] ?? ''}`)
  } catch (e) {
    console.log(`  ${String(b).padEnd(11)} нет данных${' '.repeat(16)} ${MARK[b] ?? ''}`)
  }
}

// Текущее состояние всех трёх позиций.
console.log('')
console.log('  позиции бота сейчас:')
for (const [lo, hi] of [[-63740, -63540], [-63540, -63130], [-63140, -62930]]) {
  const key = keccak256(encodePacked(['address', 'int24', 'int24'], [BOT, lo, hi]))
  const p = await client.readContract({ address: POOL, abi, functionName: 'positions', args: [key] })
  console.log(`    ${lo}..${hi}  L=${p[0]}`)
}
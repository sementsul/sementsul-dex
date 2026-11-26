// Диагностика: начислена ли комиссия позиции и можно ли её забрать.
//
// Разбирает расхождение, из-за которого collect отдаёт 0, хотя feeGrowthGlobal
// давно не ноль. Причина не в дефекте: комиссия в V3 начисляется лениво (при
// вызове _modifyPosition), а срок вестинга отсчитывается от ПЕРВОГО такого
// начисления. До первого касатия позиции vestBlock равен нулю и в pending
// ничего нет — снаружи это выглядит как «комиссии нет», хотя она накоплена в
// feeGrowthGlobal и будет посчитана при первом же mint/burn/collect.

import { createPublicClient, http, keccak256, encodePacked, formatUnits } from 'viem'
import { bsc } from 'viem/chains'
import artifacts from '../src/contracts/artifacts.json' with { type: 'json' }
import deployments from '../src/contracts/deployments.js'

const POOL = deployments.wbnbUsdtV3Pool
const OWNER = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const LOWER = -63360
const UPPER = -62950
const MAX = 2n ** 128n - 1n
const Q128 = 2n ** 128n

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const abi = artifacts.SementsulV3Pool.abi
const read = (functionName, args) => client.readContract({ address: POOL, abi, functionName, args })

const slot0 = await read('slot0')
const tickCurrent = Number(slot0[1])
const sqrtP = Number(slot0[0]) / Number(2n ** 96n)
const usdPerWbnb = 1 / (sqrtP * sqrtP)
const blockNow = await client.getBlockNumber()

const key = keccak256(encodePacked(['address', 'int24', 'int24'], [OWNER, LOWER, UPPER]))
const pos = await read('positions', [key])
const lower = await read('ticks', [LOWER])
const upper = await read('ticks', [UPPER])
const global0 = await read('feeGrowthGlobal0X128')
const global1 = await read('feeGrowthGlobal1X128')
const delay = await client.readContract({
  address: deployments.v3Factory,
  abi: artifacts.SementsulV3Factory.abi,
  functionName: 'jitDelayBlocks',
  args: [500],
})

console.log('=== пул ===')
console.log('tickCurrent        :', tickCurrent)
console.log('цена               : 1 WBNB =', usdPerWbnb.toFixed(2), 'USDT')
console.log('в диапазоне        :', tickCurrent >= LOWER && tickCurrent < UPPER ? 'да' : 'НЕТ')
console.log('задержка вестинга  :', delay.toString(), 'блоков')
console.log('')
console.log('=== позиция (сырые поля) ===')
console.log('liquidity          :', pos[0].toString())
console.log('feeGrowthInside0Last:', pos[1].toString())
console.log('feeGrowthInside1Last:', pos[2].toString())
console.log('tokensOwed0 / 1    :', pos[3].toString(), '/', pos[4].toString())
console.log('pending0 / 1       :', pos[5].toString(), '/', pos[6].toString())
console.log('vestBlock          :', pos[7].toString())
console.log('')

const below0 = tickCurrent >= LOWER ? lower[2] : global0 - lower[2]
const below1 = tickCurrent >= LOWER ? lower[3] : global1 - lower[3]
const above0 = tickCurrent < UPPER ? upper[2] : global0 - upper[2]
const above1 = tickCurrent < UPPER ? upper[3] : global1 - upper[3]
const inside0 = global0 - below0 - above0
const inside1 = global1 - below1 - above1

const owed0 = ((inside0 - pos[1]) * pos[0]) / Q128
const owed1 = ((inside1 - pos[2]) * pos[0]) / Q128
console.log('=== начислено, но ещё не перенесено в pending ===')
console.log('USDT               :', (Number(owed0) / 1e18).toFixed(8))
console.log('WBNB               :', (Number(owed1) / 1e18).toFixed(10))
console.log('в долларах         : $' + ((Number(owed0) / 1e18) + (Number(owed1) / 1e18) * usdPerWbnb).toFixed(4))
console.log('')

try {
  const sim = await client.simulateContract({
    address: POOL, abi, functionName: 'collect',
    args: [OWNER, LOWER, UPPER, MAX, MAX], account: OWNER,
  })
  console.log('=== collect прямо сейчас ===')
  console.log('USDT               :', formatUnits(sim.result[0], 18))
  console.log('WBNB               :', formatUnits(sim.result[1], 18))
  if (sim.result[0] === 0n && sim.result[1] === 0n && (owed0 > 0n || owed1 > 0n)) {
    console.log('')
    console.log('Ожидаемо: vestBlock = 0, значит этот вызов только НАЧНЁТ вестинг.')
    console.log('Он перенесёт начисленное в pending и поставит срок block+', delay.toString() + '.')
    console.log('Забрать можно будет вторым вызовом после блока', (blockNow + delay).toString() + '.')
  }
} catch (e) {
  console.log('collect откатился:', e.shortMessage ?? e.message)
}
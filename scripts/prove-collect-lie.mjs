// Доказательство: simulateContract(collect) не показывает начисленную комиссию.
//
// Проверяем на живой позиции бота. Считаем начисленное по формуле Uniswap
// (feeGrowthInside минус снимок, умноженное на ликвидность) и сравниваем с
// тем, что вернёт симуляция collect. Если формула даёт заметное число, а
// симуляция — ноль, утверждение верно.
import { createPublicClient, http, parseAbi, keccak256, encodePacked, maxUint128 } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const Q128 = 2n ** 128n

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const abi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity, uint24 fee, int24 tickSpacing)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  // TickInfo у нас — 5 полей, а не 8 как в Uniswap:
  //   [0] liquidityGross, [1] liquidityNet, [2] feeGrowthOutside0X128,
  //   [3] feeGrowthOutside1X128, [4] initialized
  // Лишние поля из Uniswap (secondsOutside, tickCumulative и т.п.) в нашем
  // контракте отсутствуют, и попытка декодировать их падает с
  // "Position is out of bounds".
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, bool initialized)',
  'function positions(bytes32) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1, uint128 pending0, uint128 pending1, uint256 vestBlock)',
  'function collect(address, int24, int24, uint128, uint128) returns (uint128, uint128)',
])

const POSITIONS = [
  ['0x922598c9D529836b4b475cE74188D5EeFFb83a88', -63140, -62930],
  ['0x922598c9D529836b4b475cE74188D5EeFFb83a88', -63540, -63130],
  ['0x922598c9D529836b4b475cE74188D5EeFFb83a88', -63740, -63540],
]

const slot0 = await client.readContract({ address: POOL, abi, functionName: 'slot0' })
const tick = Number(slot0[1])
const fg0 = await client.readContract({ address: POOL, abi, functionName: 'feeGrowthGlobal0X128' })
const fg1 = await client.readContract({ address: POOL, abi, functionName: 'feeGrowthGlobal1X128' })

console.log('  tick =', tick)
console.log('  feeGrowthGlobal0X128 =', fg0.toString())
console.log('  feeGrowthGlobal1X128 =', fg1.toString())
console.log('')

for (const [owner, lower, upper] of POSITIONS) {
  const key = keccak256(encodePacked(['address', 'int24', 'int24'], [owner, lower, upper]))
  const pos = await client.readContract({ address: POOL, abi, functionName: 'positions', args: [key] })
  const [liq, last0, last1] = pos
  if (liq === 0n) {
    console.log(`  ${lower}..${upper}: позиция закрыта, пропуск`)
    continue
  }

  const tl = await client.readContract({ address: POOL, abi, functionName: 'ticks', args: [lower] })
  const tu = await client.readContract({ address: POOL, abi, functionName: 'ticks', args: [upper] })

  const below0 = tick >= lower ? tl[2] : fg0 - tl[2]
  const below1 = tick >= lower ? tl[3] : fg1 - tl[3]
  const above0 = tick < upper ? tu[2] : fg0 - tu[2]
  const above1 = tick < upper ? tu[3] : fg1 - tu[3]
  const inside0 = fg0 - below0 - above0
  const inside1 = fg1 - below1 - above1

  // Внимание: inside может оказаться меньше снимка из-за переполнения при
  // вычитании в контракте. Проверяем знак, а не падаем.
  const d0 = inside0 >= last0 ? inside0 - last0 : 0n
  const d1 = inside1 >= last1 ? inside1 - last1 : 0n
  const owed0 = (d0 * liq) / Q128
  const owed1 = (d1 * liq) / Q128

  console.log(`  ${lower}..${upper}  L=${liq}`)
  console.log(`    по формуле: ${Number(owed0) / 1e18} USDT / ${Number(owed1) / 1e18} WBNB`)

  const sim = await client
    .simulateContract({
      address: POOL, abi, functionName: 'collect',
      args: [owner, lower, upper, maxUint128, maxUint128], account: owner,
    })
    .then((r) => r.result)
    .catch(() => null)

  if (sim) {
    console.log(`    симуляция : ${Number(sim[0]) / 1e18} USDT / ${Number(sim[1]) / 1e18} WBNB`)
    const diff = Number(owed0) - Number(sim[0])
    if (diff > 1e9) console.log(`    РАСХОЖДЕНИЕ: ${diff / 1e18} USDT — симуляция занижает`)
  } else {
    console.log('    симуляция не прошла')
  }
  console.log('')
}
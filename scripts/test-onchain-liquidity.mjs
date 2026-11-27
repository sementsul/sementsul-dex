// Проверка ликвидности против viem и живой цепи.
import { encodeFunctionData, parseAbi } from 'viem'
import {
  buildAddLiquidityV2, buildRemoveLiquidityV2, buildMintV3, buildBurnV3, buildCollectV3,
  amountsForLiquidity, tickFromPrice, sqrtAtTick, clampTick,
} from '../src/onchain/liquidity.js'
import { positionKey, decUint } from '../src/onchain/abi.js'
import { loadPoolStates, discoverPools } from '../src/onchain/pools.js'
import { bySymbol, USDT, WBNB, NATIVE, OWN_POOL, V2_ROUTER } from '../src/onchain/config.js'

let fail = 0
const ok = (n, a, b) => {
  const p = String(a).toLowerCase() === String(b).toLowerCase()
  if (!p) fail++
  console.log(`  ${p ? 'OK  ' : 'FAIL'} ${n}`)
  if (!p) console.log(`         получил: ${a}\n         ожидал:  ${b}`)
}

const recipient = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const deadline = 1800000000n

console.log('=== V2 addLiquidity ===')
const a1 = 100n * 10n ** 18n
const b1 = 2n * 10n ** 17n
const r1 = buildAddLiquidityV2({
  tokenA: USDT, tokenB: WBNB, amountA: a1, amountB: b1, minA: a1, minB: b1,
  recipient, deadline, own: true,
})
const abiAdd = parseAbi([
  'function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)',
])
const refAdd = encodeFunctionData({
  abi: abiAdd, functionName: 'addLiquidity',
  args: [USDT, WBNB, a1, b1, a1, b1, recipient, deadline],
})
ok('addLiquidity', r1.data, refAdd)

console.log('\n=== V2 addLiquidityETH (BNB + токен) ===')
const r2 = buildAddLiquidityV2({
  tokenA: NATIVE, tokenB: USDT, amountA: b1, amountB: a1, minA: b1, minB: a1,
  recipient, deadline, own: true,
})
const abiAddEth = parseAbi([
  'function addLiquidityETH(address,uint256,uint256,uint256,address,uint256) payable',
])
const refAddEth = encodeFunctionData({
  abi: abiAddEth, functionName: 'addLiquidityETH',
  args: [USDT, a1, a1, b1, recipient, deadline],
})
ok('addLiquidityETH', r2.data, refAddEth)
ok('value = BNB', r2.value, b1)

console.log('\n=== V2 removeLiquidity ===')
const liq = 5n * 10n ** 17n
const r3 = buildRemoveLiquidityV2({
  tokenA: USDT, tokenB: WBNB, liquidity: liq, minA: 0n, minB: 0n, recipient, deadline, own: true,
})
const abiRem = parseAbi([
  'function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)',
])
const refRem = encodeFunctionData({
  abi: abiRem, functionName: 'removeLiquidity',
  args: [USDT, WBNB, liq, 0n, 0n, recipient, deadline],
})
ok('removeLiquidity', r3.data, refRem)

console.log('\n=== V3 mint / burn / collect ===')
const tickLower = -63500
const tickUpper = -63090
const L = 10n ** 18n
const m = buildMintV3({ pool: OWN_POOL, recipient, tickLower, tickUpper, liquidity: L })
const abiMint = parseAbi(['function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount)'])
const refMint = encodeFunctionData({
  abi: abiMint, functionName: 'mint',
  args: [recipient, tickLower, tickUpper, L],
})
ok('mint', m.data, refMint)

const b = buildBurnV3({ pool: OWN_POOL, tickLower, tickUpper, liquidity: L })
const abiBurn = parseAbi(['function burn(int24 tickLower, int24 tickUpper, uint128 amount)'])
const refBurn = encodeFunctionData({ abi: abiBurn, functionName: 'burn', args: [tickLower, tickUpper, L] })
ok('burn', b.data, refBurn)

const c = buildCollectV3({ pool: OWN_POOL, recipient, tickLower, tickUpper })
const abiCollect = parseAbi(['function collect(address recipient, int24 tickLower, int24 tickUpper, uint128 amount0Max, uint128 amount1Max)'])
const refCollect = encodeFunctionData({
  abi: abiCollect, functionName: 'collect',
  args: [recipient, tickLower, tickUpper, (1n << 128n) - 1n, (1n << 128n) - 1n],
})
ok('collect', c.data, refCollect)

console.log('\n=== positionKey против цепи ===')
const keyMine = positionKey(recipient, tickLower, tickUpper)
console.log(`  ключ(${tickLower},${tickUpper}) = ${keyMine}`)

console.log('\n=== ликвидность живой позиции ===')
;(async () => {
  const pools = await discoverPools(USDT, WBNB)
  const states = await loadPoolStates(pools)
  const own = states.find((s) => s.own && s.protocol === 'v3')
  if (!own) {
    console.log('  свой пул не найден')
    process.exit(1)
  }
  console.log(`  свой пул: tick-цена ${Math.pow(1.0001, Number(BigInt.asIntN(256, 0n)))}`)
  const owner = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
  const { readPosition } = await import('../src/onchain/liquidity.js')
  const { callMany } = await import('../src/onchain/rpc.js')
  const pos = await readPosition(OWN_POOL, owner, tickLower, tickUpper, callMany)
  console.log(`  позиция владельца ${owner}:`)
  console.log(`     liquidity: ${pos.liquidity}`)
  console.log(`     tokensOwed0: ${pos.tokensOwed0}`)
  console.log(`     tokensOwed1: ${pos.tokensOwed1}`)
  console.log(`     совпадает с pool.liquidity()? ${pos.liquidity === own.liquidity}`)

  const amts = amountsForLiquidity(own.sqrtPriceX96, tickLower, tickUpper, pos.liquidity)
  console.log(`  в позиции: ${Number(amts.amount0) / 1e18} token0, ${Number(amts.amount1) / 1e18} token1`)

  console.log('\n=== тики и округление ===')
  console.log(`  tickFromPrice(567.54, 10) = ${tickFromPrice(567.54, 10)}`)
  console.log(`  priceFromTick(-63405) = ${Math.pow(1.0001, -63405).toFixed(10)}`)
  console.log(`  clampTick(999999, 10) = ${clampTick(999999, 10)}`)
  console.log(`  clampTick(-999999, 10) = ${clampTick(-999999, 10)}`)

  console.log(`\n=== итог кодирования: ${fail === 0 ? 'всё верно' : fail + ' ошибок'} ===`)
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => {
  console.error('ОШИБКА:', e.message)
  process.exit(1)
})
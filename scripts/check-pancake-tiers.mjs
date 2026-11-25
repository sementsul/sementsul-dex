// Проверка конкурентного утверждения: «на PancakeSwap пул BNB/USDT имеет
// комиссию 0.01% или 0.05%».
//
// От этого зависит вся стратегия «поставьте 0.01% и боты придут к вам»:
// если у Pancake на нужной паре уже 0.01%, то снижать некуда — можно только
// сравняться, а глубина у них на порядки больше.

import { createPublicClient, http, parseAbi, formatUnits } from 'viem'
import { bsc } from 'viem/chains'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-dataseed.bnbchain.org', { timeout: 20000 }),
})

const V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const USDT = '0x55d398326f99059fF775485246999027B3197955'

const factoryAbi = parseAbi([
  'function getPool(address,address,uint24) view returns (address)',
])

const poolAbi = parseAbi([
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
])

console.log('=== пулы Pancake V3 для BNB/USDT по тирам ===')
console.log()

const tiers = [100, 500, 2500, 10000]
const found = []

for (const fee of tiers) {
  const pool = await client.readContract({
    address: V3_FACTORY,
    abi: factoryAbi,
    functionName: 'getPool',
    args: [WBNB, USDT, fee],
  })

  const exists = pool && pool !== '0x0000000000000000000000000000000000000000'
  const pct = (fee / 10000).toFixed(3) + '%'
  if (!exists) {
    console.log(`тир ${String(fee).padStart(5)} (${pct.padStart(6)}): пула нет`)
    continue
  }

  const [liq, slot0] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: 'liquidity' }),
    client.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' }),
  ])

  found.push({ fee, pool, liq, tick: slot0[1] })
  console.log(`тир ${String(fee).padStart(5)} (${pct.padStart(6)}): ${pool}`)
  console.log(`      активная ликвидность: ${liq.toString()}`)
  console.log(`      тик: ${slot0[1]}`)
}

console.log()
if (found.length) {
  const best = found.reduce((a, b) => (a.liq > b.liq ? a : b))
  console.log('самый глубокий пул: тир', best.fee, `(${(best.fee / 10000).toFixed(3)}%)`)
  console.log()
  console.log('ВЫВОД для стратегии «снизим комиссию и боты придут»:')
  const hasLowest = found.some((f) => f.fee === 100)
  if (hasLowest) {
    console.log('  тир 0.01% у Pancake УЖЕ ЕСТЬ на этой паре — снижать некуда.')
    console.log('  Можно только сравняться по цене, но не по глубине.')
  }
}

// Сравним с V2: там комиссия фиксированная 0.25%.
console.log()
console.log('=== Pancake V2 (для сравнения) ===')
const V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'
const v2Abi = parseAbi(['function getPair(address,address) view returns (address)'])
const pair = await client.readContract({
  address: V2_FACTORY,
  abi: v2Abi,
  functionName: 'getPair',
  args: [WBNB, USDT],
})
console.log('пара WBNB/USDT:', pair)
if (pair !== '0x0000000000000000000000000000000000000000') {
  const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'])
  const [b0, b1, d0, d1] = await Promise.all([
    client.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [pair] }),
    client.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [pair] }),
    client.readContract({ address: WBNB, abi: erc20, functionName: 'decimals' }),
    client.readContract({ address: USDT, abi: erc20, functionName: 'decimals' }),
  ])
  const bnb = Number(formatUnits(b0, d0))
  const usdt = Number(formatUnits(b1, d1))
  console.log('резерв WBNB:', bnb.toFixed(2))
  console.log('резерв USDT:', usdt.toFixed(2))
  console.log('TVL:', (usdt * 2).toFixed(0), 'USD')
  console.log('комиссия Pancake V2: 0.25% (зашита в контракт)')
}
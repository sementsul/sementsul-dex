// Проверяем порядок токенов в пулах, с которыми работает бот, и какой
// именно смысл имеет цена в его коде.

import { createPublicClient, http, formatUnits } from 'viem'
import { bsc } from 'viem/chains'
import artifacts from '../src/contracts/artifacts.json' with { type: 'json' }

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const abi = artifacts.SementsulV3Pool.abi

const USDT = '0x55d398326f99059fF775485246999027B3197955'.toLowerCase()
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'.toLowerCase()

const pools = {
  'бот: pool (0.05%)': '0x36696169C63e42cd08ce11f5deeBbCeBae652050',
  'бот: refPool (0.01%)': '0x172fcD41E0913e95784454622d1c3724f546f849',
  'наш пул (0.05%)': '0x3688726E5811E766A0cA014dCEC24622c0d02583',
}

for (const [label, addr] of Object.entries(pools)) {
  const t0 = (await client.readContract({ address: addr, abi, functionName: 'token0' })).toLowerCase()
  const t1 = (await client.readContract({ address: addr, abi, functionName: 'token1' })).toLowerCase()
  const s = await client.readContract({ address: addr, abi, functionName: 'slot0' })
  const sqrtP = Number(s[0]) / Number(2n ** 96n)
  const poolPrice = sqrtP * sqrtP // token1 за token0

  const t0Name = t0 === USDT ? 'USDT' : t0 === WBNB ? 'WBNB' : t0.slice(0, 8)
  const t1Name = t1 === USDT ? 'USDT' : t1 === WBNB ? 'WBNB' : t1.slice(0, 8)

  console.log(`=== ${label} ===`)
  console.log(`  token0 = ${t0Name}, token1 = ${t1Name}`)
  console.log(`  slot0.tick = ${Number(s[1])}`)
  console.log(`  price (token1/token0) = ${poolPrice.toExponential(6)}`)

  // Как это читается в привычных единицах
  if (t0Name === 'USDT' && t1Name === 'WBNB') {
    console.log(`  => 1 токен0 (USDT) = ${poolPrice.toExponential(6)} WBNB`)
    console.log(`  => 1 WBNB = ${(1 / poolPrice).toFixed(2)} USDT  <- привычная цена`)
  } else if (t0Name === 'WBNB' && t1Name === 'USDT') {
    console.log(`  => 1 WBNB = ${poolPrice.toFixed(2)} USDT  <- привычная цена напрямую`)
  }
  console.log('')
}

// Проверяем формулу бота: ticksForLevel(556, 5) при условии, что pool price —
// это WBNB за USDT.
const tickFromPrice = (p) => Math.round(Math.log(p) / Math.log(1.0001))
const alignTick = (t, sp, dir) => {
  const v = BigInt(Math.trunc(t)); const s = BigInt(sp); const rem = (v % s + s) % s
  if (rem === 0n) return Number(v)
  return Number(dir > 0 ? v + (s - rem) : v - rem)
}
const level = 556, pct = 5
const lo = level * (1 - pct / 100), hi = level * (1 + pct / 100)
const lower = alignTick(tickFromPrice(1 / hi), 10, -1)
const upper = alignTick(tickFromPrice(1 / lo), 10, 1)
console.log('=== формула бота ticksForLevel(556, 5, 10) ===')
console.log(`  lo=${lo.toFixed(2)} hi=${hi.toFixed(2)} USDT за WBNB`)
console.log(`  lower=${lower} upper=${upper}`)
console.log(`  цена на lower = ${(1 / Math.pow(1.0001, lower)).toFixed(2)} USDT за WBNB`)
console.log(`  цена на upper = ${(1 / Math.pow(1.0001, upper)).toFixed(2)} USDT за WBNB`)
console.log('')
console.log('  => lower соответствует ВЕРХНЕЙ цене, upper — НИЖНЕЙ.')
console.log('  => формула уже написана под пул, где цена = WBNB за USDT.')
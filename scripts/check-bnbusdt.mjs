// Состояние пулов WBNB/USDT: у нас и на Pancake для сверки цены.
//
// Нужен перед созданием пула, потому что цену в V3-пуле задают один раз и
// навсегда. Если задать её не по рынку, пул будет пустым: арбитраж вычерпает
// любую ликвидность в одну сторону, а LP потеряют деньги.
//
// Поэтому берём sqrtPriceX96 прямо из пула Pancake с наибольшей глубиной и
// используем ровно это значение.
//
// Использование: node scripts/check-bnbusdt.mjs

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, formatUnits, formatEther } from 'viem'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RPC = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'

const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))
const { default: d } = await import(new URL('../src/contracts/deployments.js', import.meta.url).href)

const c = createPublicClient({ chain: bsc, transport: http(RPC) })

const WBNB = d.wbnb
// USDT на BSC — 18 знаков, не 6. Это частая ошибка при расчёте цены.
const USDT = '0x55d398326f99059fF775485246999027B3197955'

const v3PoolAbi = artifacts.SementsulV3Pool.abi
const erc20 = artifacts.SementsulToken.abi

// Q96 = 2^96 — множитель в sqrtPriceX96.
const Q96 = 2n ** 96n

// Цена token1 за token0 из sqrtPriceX96.
function priceFromSqrt(sqrtPriceX96, dec0, dec1) {
  const s = Number(sqrtPriceX96) / Number(Q96)
  const raw = s * s
  // raw — в единицах сырых значений; приводим к человеческим.
  return raw * 10 ** (dec0 - dec1)
}

console.log('=== наши пулы WBNB/USDT ===\n')

// V2
const v2Pair = await c
  .readContract({
    address: d.factory,
    abi: artifacts.SementsulFactory.abi,
    functionName: 'getPair',
    args: [WBNB, USDT],
  })
  .catch(() => null)

console.log('V2:', !v2Pair || v2Pair === '0x0000000000000000000000000000000000000000' ? 'пары нет' : v2Pair)

// V3 по всем тирам
console.log('\nV3:')
for (const fee of d.v3FeeTiers) {
  const pool = await c
    .readContract({
      address: d.v3Factory,
      abi: artifacts.SementsulV3Factory.abi,
      functionName: 'getPool',
      args: [WBNB, USDT, fee],
    })
    .catch(() => null)
  const exists = pool && pool !== '0x0000000000000000000000000000000000000000'
  console.log(`  тир ${String(fee).padStart(5)}: ${exists ? pool : 'пула нет'}`)
}

// ---------- Pancake для сверки ----------
console.log('\n=== Pancake: откуда берём цену ===\n')

const PANCAKE = [
  { name: 'V3 0.05%', pool: '0x36696169C63e42cd08ce11f5deeBbCeBae652050', fee: 500 },
  { name: 'V3 0.01%', pool: '0x172fcD41E0913e95784454622d1c3724f546f849', fee: 100 },
]

for (const p of PANCAKE) {
  try {
    const [slot0, liq, t0, t1] = await Promise.all([
      c.readContract({ address: p.pool, abi: v3PoolAbi, functionName: 'slot0' }),
      c.readContract({ address: p.pool, abi: v3PoolAbi, functionName: 'liquidity' }),
      c.readContract({ address: p.pool, abi: v3PoolAbi, functionName: 'token0' }),
      c.readContract({ address: p.pool, abi: v3PoolAbi, functionName: 'token1' }),
    ])
    const sqrt = slot0[0]
    const tick = Number(slot0[1])
    const price = priceFromSqrt(sqrt, 18, 18)
    console.log(`${p.name}`)
    console.log(`  sqrtPriceX96: ${sqrt}`)
    console.log(`  tick:         ${tick}`)
    console.log(`  liquidity:    ${liq}`)
    console.log(`  token0:       ${t0}`)
    console.log(`  token1:       ${t1}`)
    // Если token0 = USDT, то цена считается наоборот.
    const usdtFirst = t0.toLowerCase() === USDT.toLowerCase()
    console.log(`  цена:         1 ${usdtFirst ? 'USDT' : 'WBNB'} = ${usdtFirst ? (1 / price).toFixed(4) : price.toFixed(4)} ${usdtFirst ? 'WBNB' : 'USDT'}`)
    console.log('')
  } catch (e) {
    console.log(`${p.name}: ошибка ${(e.shortMessage ?? e.message).slice(0, 80)}\n`)
  }
}

// ---------- баланс деплоера ----------
const bal = await c.getBalance({ address: d.deployer })
const gasPrice = await c.getGasPrice()
console.log('=== средства ===\n')
console.log('деплоер:', d.deployer)
console.log('BNB:    ', formatEther(bal))
console.log('газ:    ', Number(gasPrice) / 1e9, 'gwei')
// createPool деплоит контракт пула: ~4.3 млн газа по замеру
console.log('хватит на createPool (~4.3 млн газа):', bal > 4_300_000n * gasPrice ? 'да' : 'НЕТ')
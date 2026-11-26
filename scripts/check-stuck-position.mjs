// Проверяем ключевое утверждение документа: «ни при какой цене спасти нельзя».
//
// Аналитически разность inside - last после дефектного минта равна
// global_now - 2*global_mint независимо от того, где цена. Значит позиция
// разблокируется, когда глобальная комиссия УДВОИТСЯ. Проверяем это на живом
// пуле: сколько осталось до удвоения.

import { createPublicClient, http, keccak256, encodePacked } from 'viem'
import { bsc } from 'viem/chains'
import artifacts from '../src/contracts/artifacts.json' with { type: 'json' }
import deployments from '../src/contracts/deployments.js'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const POOL = deployments.wbnbUsdtV3Pool
const abi = artifacts.SementsulV3Pool.abi

// Запертая позиция из документа.
const OWNER = process.env.STUCK_OWNER
const LOWER = -63270
const UPPER = -63230

const g = await client.readContract({ address: POOL, abi, functionName: 'feeGrowthGlobal0X128' })
const g1 = await client.readContract({ address: POOL, abi, functionName: 'feeGrowthGlobal1X128' })
const s = await client.readContract({ address: POOL, abi, functionName: 'slot0' })

console.log('=== живой пул ===')
console.log('  tick           ', Number(s[1]))
console.log('  global0        ', g.toString())
console.log('  global1        ', g1.toString())
console.log('')

if (!OWNER) {
  console.log('STUCK_OWNER не задан — ищем позицию перебором известных адресов.')
  const { execSync } = await import('node:child_process')
  console.log('  (укажите адрес владельца запертой позиции в STUCK_OWNER)')
  process.exit(0)
}

const key = keccak256(encodePacked(['address', 'int24', 'int24'], [OWNER, LOWER, UPPER]))
const p = await client.readContract({ address: POOL, abi, functionName: 'positions', args: [key] })

console.log('=== запертая позиция ===')
console.log('  owner          ', OWNER)
console.log('  диапазон       ', LOWER, '..', UPPER)
console.log('  liquidity      ', p[0].toString())
console.log('  last0          ', p[1].toString())
console.log('  last1          ', p[2].toString())
console.log('  tokensOwed0    ', p[3].toString())
console.log('  pending0       ', p[5].toString())
console.log('  vestBlock      ', p[7].toString())
console.log('')

const last0 = p[1]
const doubled = last0 * 2n
const remaining = doubled > g ? doubled - g : 0n
const pct = last0 > 0n ? Number((g * 10000n) / last0) / 100 : 0

console.log('=== до разблокировки ===')
console.log('  нужно global0  ', doubled.toString())
console.log('  сейчас         ', g.toString())
console.log('  прогресс       ', pct.toFixed(2) + '% от нужного')
console.log('  осталось       ', remaining.toString())
console.log('')
console.log(remaining === 0n
  ? 'ВЫВОД: условие удвоения уже выполнено — позиция должна открыться.'
  : 'ВЫВОД: позиция заперта до удвоения глобальной комиссии, то есть пока')
if (remaining > 0n) {
  console.log('       не наберётся ещё столько же комиссии, сколько было на момент минта.')
}
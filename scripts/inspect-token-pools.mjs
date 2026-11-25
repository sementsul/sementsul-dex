// Что сейчас с токеном SEM на цепи: пулы, ликвидность, сделки.
//
// Нужен, чтобы отличить «пул не создался» от «пул создан, но в нём пусто» и от
// «в пуле есть ликвидность, но цены на BscScan нет по другой причине».
//
// Использование: node scripts/inspect-token-pools.mjs

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, formatUnits, parseAbiItem } from 'viem'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RPC = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'

const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))
const { default: d } = await import(new URL('../src/contracts/deployments.js', import.meta.url).href)

const c = createPublicClient({ chain: bsc, transport: http(RPC) })

const TOKEN = d.token
const WBNB = d.wbnb
const v2Abi = artifacts.SementsulFactory.abi
const v2PairAbi = artifacts.SementsulPair?.abi ?? artifacts.SementsulRouter.abi
const v3Abi = artifacts.SementsulV3Factory.abi
const v3PoolAbi = artifacts.SementsulV3Pool.abi
const erc20 = artifacts.SementsulToken.abi

console.log('токен SEM:', TOKEN)
console.log('WBNB:     ', WBNB)
console.log('')

// ---------- V2 ----------
// getPair(tokenA, tokenB) возвращает адрес пары или нулевой, если её нет.
console.log('=== V2 ===')
let v2Pair = null
try {
  v2Pair = await c.readContract({
    address: d.factory,
    abi: v2Abi,
    functionName: 'getPair',
    args: [TOKEN, WBNB],
  })
} catch (e) {
  console.log('  ошибка чтения getPair:', e.shortMessage ?? e.message)
}

if (!v2Pair || v2Pair === '0x0000000000000000000000000000000000000000') {
  console.log('  пары SEM/WBNB нет')
} else {
  console.log('  пара: ' + v2Pair)
  const [r0, r1, t0, supply] = await Promise.all([
    c.readContract({ address: v2Pair, abi: artifacts.SementsulPair.abi, functionName: 'getReserves' }).catch(() => null),
    Promise.resolve(null),
    c.readContract({ address: v2Pair, abi: artifacts.SementsulPair.abi, functionName: 'token0' }).catch(() => null),
    c.readContract({ address: v2Pair, abi: artifacts.SementsulPair.abi, functionName: 'totalSupply' }).catch(() => null),
  ])
  if (r0) {
    const [reserve0, reserve1] = r0
    console.log(`  token0: ${t0}`)
    console.log(`  резерв token0: ${formatUnits(reserve0, 18)}`)
    console.log(`  резерв token1: ${formatUnits(reserve1, 18)}`)
    console.log(`  LP всего:      ${formatUnits(supply ?? 0n, 18)}`)
  }
}

// ---------- V3 ----------
console.log('\n=== V3 ===')
for (const fee of d.v3FeeTiers) {
  let pool = null
  try {
    pool = await c.readContract({
      address: d.v3Factory,
      abi: v3Abi,
      functionName: 'getPool',
      args: [TOKEN, WBNB, fee],
    })
  } catch (e) {
    console.log(`  тир ${fee}: ошибка чтения`)
    continue
  }
  if (!pool || pool === '0x0000000000000000000000000000000000000000') {
    console.log(`  тир ${fee}: пула нет`)
    continue
  }
  const [liq, slot0, bal0, bal1] = await Promise.all([
    c.readContract({ address: pool, abi: v3PoolAbi, functionName: 'liquidity' }).catch(() => null),
    c.readContract({ address: pool, abi: v3PoolAbi, functionName: 'slot0' }).catch(() => null),
    c.readContract({ address: TOKEN, abi: erc20, functionName: 'balanceOf', args: [pool] }).catch(() => null),
    c.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [pool] }).catch(() => null),
  ])
  console.log(`  тир ${fee}: пул ${pool}`)
  console.log(`    liquidity: ${liq ?? '?'}`)
  console.log(`    sqrtPriceX96: ${slot0 ? slot0[0] : '?'}`)
  console.log(`    баланс SEM в пуле:  ${bal0 !== null ? formatUnits(bal0, 18) : '?'}`)
  console.log(`    баланс WBNB в пуле: ${bal1 !== null ? formatUnits(bal1, 18) : '?'}`)
}

// ---------- были ли сделки ----------
console.log('\n=== сделки ===')
const [v2N, v3N] = await Promise.all([
  c.getTransactionCount({ address: v2Pair ?? '0x0000000000000000000000000000000000000000' }).catch(() => 0),
  c.getBlockNumber(),
])
console.log('текущий блок:', v3N)
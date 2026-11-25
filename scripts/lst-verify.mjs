// Правильный замер глубины LST-пулов.
//
// В прошлой версии была ошибка: balanceOf вызывался У САМОГО ПУЛА, а пул не
// является ERC-20 — вызов ревертил, ошибка глушилась, и TVL показывался
// нулевым. Здесь читаем балансы у токенов, как и положено.

import { createPublicClient, http, parseAbi } from 'viem'

const RPC = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'
const client = createPublicClient({ transport: http(RPC) })

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'
const V3_FACTORY = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'

const SLIS = '0xB0b84D294e0C75A6abe60171b70edEb2EFd14A1B'
const TIERS = [100, 500, 2500, 10000]

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
])
const v2Fab = parseAbi(['function getPair(address,address) view returns (address)'])
const v2Pair = parseAbi([
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
])
const v3Fab = parseAbi(['function getPool(address,address,uint24) view returns (address)'])
const v3Pool = parseAbi([
  'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
  'function token0() view returns (address)',
])

const ZERO = '0x0000000000000000000000000000000000000000'
const fmt = (x, d = 2) => Number(x).toLocaleString('ru-RU', { maximumFractionDigits: d })

// Цена BNB в USDT из самого глубокого пула Pancake V2.
async function bnbUsd() {
  const pair = await client.readContract({
    address: V2_FACTORY,
    abi: v2Fab,
    functionName: 'getPair',
    args: [WBNB, USDT],
  })
  const [r0, r1] = await client.readContract({ address: pair, abi: v2Pair, functionName: 'getReserves' })
  const t0 = await client.readContract({ address: pair, abi: v2Pair, functionName: 'token0' })
  const wbnbFirst = t0.toLowerCase() === WBNB.toLowerCase()
  return Number(wbnbFirst ? r1 : r0) / Number(wbnbFirst ? r0 : r1)
}

const px = await bnbUsd()
console.log('=== глубина LST-пулов на Pancake (перепроверка) ===')
console.log(`цена BNB: $${px.toFixed(2)}\n`)

const supply = await client.readContract({ address: SLIS, abi: erc20, functionName: 'totalSupply' })
const supplyHuman = Number(supply) / 1e18
console.log(`slisBNB всего выпущено: ${fmt(supplyHuman, 0)} ≈ $${fmt(supplyHuman * 1.037 * px, 0)}\n`)

// --- V2 ---
console.log('--- Pancake V2 ---')
for (const [label, other, decOther] of [
  ['slisBNB/WBNB', WBNB, 18],
  ['slisBNB/USDT', USDT, 18],
]) {
  const pair = await client.readContract({
    address: V2_FACTORY,
    abi: v2Fab,
    functionName: 'getPair',
    args: [SLIS, other],
  })
  if (pair === ZERO) {
    console.log(`${label}: пары нет`)
    continue
  }
  const [r0, r1] = await client.readContract({ address: pair, abi: v2Pair, functionName: 'getReserves' })
  const t0 = await client.readContract({ address: pair, abi: v2Pair, functionName: 'token0' })
  const slisFirst = t0.toLowerCase() === SLIS.toLowerCase()
  const rLst = Number(slisFirst ? r0 : r1) / 1e18
  const rOth = Number(slisFirst ? r1 : r0) / 10 ** decOther
  const tvlUsd = other === WBNB ? rOth * 2 * px : rOth * 2
  console.log(`${label}: ${fmt(rLst, 6)} slisBNB / ${fmt(rOth, 2)} — TVL $${fmt(tvlUsd)}`)
}

// --- V3 ---
console.log('\n--- Pancake V3 ---')
let v3Total = 0
for (const fee of TIERS) {
  const pool = await client.readContract({
    address: V3_FACTORY,
    abi: v3Fab,
    functionName: 'getPool',
    args: [SLIS, WBNB, fee],
  })
  if (pool === ZERO) {
    console.log(`${(fee / 10000).toFixed(2)}%: пула нет`)
    continue
  }
  const t0 = await client.readContract({ address: pool, abi: v3Pool, functionName: 'token0' })
  const lstIsT0 = t0.toLowerCase() === SLIS.toLowerCase()

  // Балансы читаем у ТОКЕНОВ, а не у пула.
  const balLst = await client.readContract({
    address: SLIS,
    abi: erc20,
    functionName: 'balanceOf',
    args: [pool],
  })
  const balWbnb = await client.readContract({
    address: WBNB,
    abi: erc20,
    functionName: 'balanceOf',
    args: [pool],
  })

  const lstAmt = Number(balLst) / 1e18
  const wbnbAmt = Number(balWbnb) / 1e18
  const tvlUsd = (lstAmt * 1.037 + wbnbAmt) * px
  v3Total += tvlUsd

  console.log(
    `${(fee / 10000).toFixed(2)}%: ${fmt(lstAmt, 4)} slisBNB / ${fmt(wbnbAmt, 4)} WBNB — TVL $${fmt(tvlUsd)} (token0=${lstIsT0 ? 'slisBNB' : 'WBNB'})`
  )
}
console.log(`\nитого в V3: $${fmt(v3Total)}`)

console.log('\n--- вывод ---')
console.log('Если все пулы Pancake вместе дают единицы тысяч долларов,')
console.log('то «арбитраж на дрейфе курса» уходит не к нам: он и так уже')
console.log('обслуживается там, где есть ликвидность.')
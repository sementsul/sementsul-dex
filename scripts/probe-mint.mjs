// Подбор ликвидности, которую пул реально примет.
//
// Зачем: mint может откатиться, даже когда allowance и балансы на месте.
// Причина — округление. Контракт считает суммы токенов с roundUp = true, а
// наш расчёт ликвидности идёт в числах с плавающей точкой. Разница в
// последнем разряде приводит к тому, что transferFrom просит на 1 wei
// больше, чем разрешено, и вся транзакция падает.
//
// Поэтому: перебираем L от расчётного вниз, пока eth_call не пройдёт, и
// печатаем точные суммы, которые спишет контракт.
//
// Использование: node scripts/probe-mint.mjs

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, parseAbi, formatUnits, encodeFunctionData } from 'viem'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RPC = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'

const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))
const { default: d } = await import(new URL('../src/contracts/deployments.js', import.meta.url).href)

const OWNER = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const POOL = d.wbnbUsdtV3Pool
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'])

const read = createPublicClient({ chain: bsc, transport: http(RPC) })

const slot0 = await read.readContract({ address: POOL, abi: artifacts.SementsulV3Pool.abi, functionName: 'slot0' })
const tick = Number(slot0[1])
const spacing = Number(slot0[4])

const pct = 2
const dTicks = Math.log(1 + pct / 100) / Math.log(1.0001)
const tickLower = Math.floor((tick - dTicks) / spacing) * spacing
const tickUpper = Math.ceil((tick + dTicks) / spacing) * spacing

console.log('пул:      ', POOL)
console.log('тик:      ', tick, '| шаг:', spacing)
console.log('диапазон: ', tickLower, '..', tickUpper)

const [wbnbBal, usdtBal, wAl, uAl] = await Promise.all([
  read.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [OWNER] }),
  read.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [OWNER] }),
  read.readContract({ address: WBNB, abi: erc20, functionName: 'allowance', args: [OWNER, POOL] }),
  read.readContract({ address: USDT, abi: erc20, functionName: 'allowance', args: [OWNER, POOL] }),
])

console.log('')
console.log('баланс USDT:', formatUnits(usdtBal, 18), '| allowance:', formatUnits(uAl, 18))
console.log('баланс WBNB:', formatUnits(wbnbBal, 18), '| allowance:', formatUnits(wAl, 18))

// Начальная оценка L из формулы, как в add-liquidity.mjs.
const sqrtP = Number(slot0[0]) / Number(2n ** 96n)
const sqrtL = Math.pow(1.0001, tickLower / 2)
const sqrtU = Math.pow(1.0001, tickUpper / 2)
const a0PerL = (sqrtU - sqrtP) / (sqrtP * sqrtU)
const a1PerL = sqrtP - sqrtL

const LbyWbnb = Number(wbnbBal) / 1e18 / a1PerL
const LbyUsdt = Number(usdtBal) / 1e18 / a0PerL

console.log('')
console.log('L по WBNB:', Math.floor(LbyWbnb * 1e18))
console.log('L по USDT:', Math.floor(LbyUsdt * 1e18))

// Идём вниз от оценки: на каждом шаге проверяем eth_call.
// Шаг 0.1% от суммы — этого с запасом хватает на любое расхождение округления.
let L = Math.floor(Math.min(LbyWbnb, LbyUsdt) * 1e18)

const abiMint = parseAbi(['function mint(address,int24,int24,uint128) returns (uint256,uint256)'])

let found = null
for (let i = 0; i < 40; i++) {
  const Li = BigInt(Math.floor(L * (1 - i * 0.001)))
  if (Li <= 0n) break
  const data = encodeFunctionData({
    abi: abiMint,
    functionName: 'mint',
    args: [OWNER, tickLower, tickUpper, Li],
  })
  try {
    const r = await read.call({ to: POOL, data, account: OWNER })
    // Вернулись два uint256: сколько USDT и WBNB спишет контракт.
    const amount0 = BigInt('0x' + r.data.slice(2, 66))
    const amount1 = BigInt('0x' + r.data.slice(66, 130))
    found = { L: Li, amount0, amount1, i }
    break
  } catch {
    // пробуем меньше
  }
}

if (!found) {
  console.log('\nне удалось подобрать L — уменьшайте сильнее')
  process.exit(1)
}

console.log('')
console.log('=== проходит при L ===')
console.log('  L:', found.L.toString())
console.log('  шаг вниз:', found.i, '(0.1% каждый)')
console.log('  спишет USDT:', formatUnits(found.amount0, 18))
console.log('  спишет WBNB:', formatUnits(found.amount1, 18))
console.log('')
console.log('сравнение с allowance:')
console.log('  USDT хватает:', found.amount0 <= uAl, `(${formatUnits(uAl, 18)} разрешено)`)
console.log('  WBNB хватает:', found.amount1 <= wAl, `(${formatUnits(wAl, 18)} разрешено)`)
console.log('')
console.log('для add-liquidity.mjs: --liquidity', found.L.toString())
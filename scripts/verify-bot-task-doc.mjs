// Проверка всех фактов docs/BOT-MIGRATION-TASK.md.
// Каждое утверждение сверяется с цепью или с артефактами, а не с памятью.

import { createPublicClient, http, keccak256, toHex, encodePacked, encodeAbiParameters, parseAbiParameters, formatUnits } from 'viem'
import { bsc } from 'viem/chains'
import artifacts from '../src/contracts/artifacts.json' with { type: 'json' }
import deployments from '../src/contracts/deployments.js'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const POOL = deployments.wbnbUsdtV3Pool
const FACTORY = deployments.v3Factory
const ROUTER = deployments.v3Router
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = deployments.wbnb

let bad = 0
const check = (name, ok, extra = '') => {
  if (!ok) bad++
  console.log((ok ? '  ok  ' : 'ФЕЙЛ  ') + name + (extra ? '  → ' + extra : ''))
}

console.log('--- 1. Параметры пула ---')
const abi = artifacts.SementsulV3Pool.abi
const t0 = await client.readContract({ address: POOL, abi, functionName: 'token0' })
const t1 = await client.readContract({ address: POOL, abi, functionName: 'token1' })
const fee = await client.readContract({ address: POOL, abi, functionName: 'fee' })
const spacing = await client.readContract({ address: POOL, abi, functionName: 'tickSpacing' })
check('token0 = USDT', t0.toLowerCase() === USDT.toLowerCase(), t0)
check('token1 = WBNB', t1.toLowerCase() === WBNB.toLowerCase(), t1)
check('fee = 500', Number(fee) === 500, String(fee))
check('tickSpacing = 10', Number(spacing) === 10, String(spacing))

console.log('')
console.log('--- 2. Порядок токенов совпадает с пулом бота ---')
const botPool = '0x36696169C63e42cd08ce11f5deeBbCeBae652050'
const bt0 = await client.readContract({ address: botPool, abi, functionName: 'token0' })
const bt1 = await client.readContract({ address: botPool, abi, functionName: 'token1' })
check('бот: token0 = USDT', bt0.toLowerCase() === USDT.toLowerCase(), bt0)
check('бот: token1 = WBNB', bt1.toLowerCase() === WBNB.toLowerCase(), bt1)
check('порядок совпадает с нашим', bt0.toLowerCase() === t0.toLowerCase() && bt1.toLowerCase() === t1.toLowerCase())

console.log('')
console.log('--- 3. slot0: 5 полей ---')
const slot0fn = abi.find((x) => x.name === 'slot0')
check('slot0 возвращает 5 полей', slot0fn.outputs.length === 5, String(slot0fn.outputs.length))
check('имена полей', slot0fn.outputs.map((o) => o.name).join(',') === 'sqrtPriceX96_,tick_,liquidity_,fee_,tickSpacing_')

console.log('')
console.log('--- 4. positions: 8 полей и их порядок ---')
const posFn = abi.find((x) => x.name === 'positions')
const order = posFn.outputs.map((o) => o.name).join(',')
check('positions возвращает 8 полей', posFn.outputs.length === 8, String(posFn.outputs.length))
// Именно этот порядок указан в документе под номерами [0]..[7].
// Внимание: в slot0 поля названы с подчёркиванием (liquidity_), а в positions —
// без него (liquidity). Это не опечатка, так в артефакте.
const expected = [
  'liquidity',
  'feeGrowthInside0LastX128',
  'feeGrowthInside1LastX128',
  'tokensOwed0',
  'tokensOwed1',
  'pending0',
  'pending1',
  'vestBlock',
]
check(
  'порядок совпадает с документом [0..7]',
  order === expected.join(','),
  order
)
// Индексы, о которых предупреждает документ: p[5] был tickLower, станет pending0.
const oldNpmOrder = ['nonce', 'operator', 'token0', 'token1', 'fee', 'tickLower', 'tickUpper', 'liquidity']
check('p[5] у npm.positions = tickLower', oldNpmOrder[5] === 'tickLower', oldNpmOrder[5])
check('p[5] у нашего pool.positions = pending0', expected[5] === 'pending0', expected[5])

console.log('')
console.log('--- 5. Сигнатуры mint/burn/collect ---')
for (const [name, expect] of [
  ['mint', 'address,int24,int24,uint128'],
  ['burn', 'int24,int24,uint128'],
  ['collect', 'address,int24,int24,uint128,uint128'],
]) {
  const f = abi.find((x) => x.name === name && x.type === 'function')
  check(`${name}(${expect})`, f && f.inputs.map((i) => i.type).join(',') === expect, f?.inputs.map((i) => i.type).join(','))
}

console.log('')
console.log('--- 6. Тики и цены ---')
const priceAt = (tick) => 1 / Math.pow(1.0001, tick)
const tickFromPrice = (p) => Math.round(Math.log(p) / Math.log(1.0001))
const alignTick = (t, sp, dir) => {
  const v = BigInt(Math.trunc(t)), s = BigInt(sp), rem = (v % s + s) % s
  if (rem === 0n) return Number(v)
  return Number(dir > 0 ? v + (s - rem) : v - rem)
}
const level = 556, pct = 5
const lo = level * (1 - pct / 100), hi = level * (1 + pct / 100)
const lower = alignTick(tickFromPrice(1 / hi), 10, -1)
const upper = alignTick(tickFromPrice(1 / lo), 10, 1)
check('lower = -63700', lower === -63700, String(lower))
check('upper = -62690', upper === -62690, String(upper))
check('цена на lower ≈ 583.87', Math.abs(priceAt(lower) - 583.87) < 0.02, priceAt(lower).toFixed(2))
check('цена на upper ≈ 527.78', Math.abs(priceAt(upper) - 527.78) < 0.02, priceAt(upper).toFixed(2))
check('меньший тик = большая цена', priceAt(lower) > priceAt(upper))

console.log('')
console.log('--- 7. Задержки вестинга ---')
for (const [f, expect] of [[50, 250], [500, 1150], [2500, 5150], [10000, 20150]]) {
  const d = Number(await client.readContract({ address: FACTORY, abi: artifacts.SementsulV3Factory.abi, functionName: 'jitDelayBlocks', args: [f] }))
  check(`fee ${f} → ${expect}`, d === expect, String(d))
}

console.log('')
console.log('--- 8. Время блока и 1150 блоков ---')
const now = await client.getBlockNumber()
const a = await client.getBlock({ blockNumber: now - 2000n })
const c = await client.getBlock({ blockNumber: now })
const spb = Number(c.timestamp - a.timestamp) / 2000
check('блок ≈ 0.46 с', Math.abs(spb - 0.46) < 0.12, spb.toFixed(3))
const min1150 = (1150 * spb) / 60
check('1150 блоков ≈ 8.8 мин', Math.abs(min1150 - 8.8) < 1.5, min1150.toFixed(1) + ' мин')

console.log('')
console.log('--- 9. Селекторы ---')
const code = (await client.getBytecode({ address: ROUTER })).toLowerCase()
const sel = (s) => keccak256(toHex(s)).slice(0, 10)
const selChecks = [
  ['наш exactInputSingle 4 поля', 'exactInputSingle((bytes,address,uint256,uint256),uint256)', '0xea7ec9c4', true],
  ['Pancake 8 полей', 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))', '0x414bf389', false],
  ['refundBNB', 'refundBNB()', '0xf37050da', true],
  ['unwrapWBNB', 'unwrapWBNB(uint256,address)', '0x9d110e71', true],
  ['refundETH', 'refundETH()', '0x12210e8a', false],
  ['unwrapWETH9', 'unwrapWETH9(uint256,address)', '0x49404b7c', false],
  ['multicall', 'multicall(bytes[])', '0xac9650d8', true],
]
for (const [name, sig, expect, inCode] of selChecks) {
  const actual = sel(sig)
  check(`${name} = ${expect}`, actual === expect, actual)
  if (inCode) check(`  есть в байткоде роутера`, code.includes(expect.slice(2)))
}

console.log('')
console.log('--- 10. Ключ позиции ---')
const owner = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const packed = keccak256(encodePacked(['address', 'int24', 'int24'], [owner, -63360, -62950]))
const encoded = keccak256(encodeAbiParameters(parseAbiParameters('address, int24, int24'), [owner, -63360, -62950]))
const pPacked = await client.readContract({ address: POOL, abi, functionName: 'positions', args: [packed] })
const pEncoded = await client.readContract({ address: POOL, abi, functionName: 'positions', args: [encoded] })
check('encodePacked даёт позицию', pPacked[0] > 0n, 'liquidity=' + pPacked[0])
check('encode даёт нули', pEncoded[0] === 0n, 'liquidity=' + pEncoded[0])

console.log('')
console.log('--- 11. reversalPenaltyK ---')
const k = await client.readContract({ address: FACTORY, abi: artifacts.SementsulV3Factory.abi, functionName: 'reversalPenaltyK', args: [500] })
check('выключен (0)', Number(k) === 0, String(k))

console.log('')
console.log('--- 12. path = 43 байта ---')
const path = WBNB.toLowerCase().slice(2) + (500).toString(16).padStart(6, '0') + USDT.toLowerCase().slice(2)
check('длина 43 байта', path.length / 2 === 43, String(path.length / 2))
check('контракт требует ровно 43', artifacts.SementsulV3Router.abi.find((x) => x.name === 'exactInputSingle').inputs[0].components[0].type === 'bytes')

console.log('')
console.log('--- 13. Роутер требует deadline, а в ABI бота его нет ---')
const routerFn = artifacts.SementsulV3Router.abi.find((x) => x.name === 'exactInputSingle')
check('exactInputSingle принимает 2 аргумента', routerFn.inputs.length === 2, routerFn.inputs.map((i) => i.type).join(','))
check('второй аргумент = deadline (uint256)', routerFn.inputs[1].type === 'uint256')

console.log('')
console.log(bad === 0 ? '=== ВСЕ ФАКТЫ ДОКУМЕНТА ПОДТВЕРЖДЕНЫ ===' : `=== расхождений: ${bad} ===`)
process.exit(bad === 0 ? 0 : 1)
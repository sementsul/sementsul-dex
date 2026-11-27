// Почему в нашем пуле нет арбитража: измеряем причины по очереди.
//
// Арбитраж требует одновременно трёх вещей, и отсутствие любой убивает его
// целиком:
//   1) цена в пуле отличается от внешней больше, чем стоят издержки;
//   2) арбитражник знает о существовании пула;
//   3) прибыль с расхождения больше газа и он не съедается штрафами.
//
// Здесь меряем каждую.
//
// ВАЖНО про ABI: у нашего пула slot0 возвращает 5 полей
//   (sqrtPriceX96, tick, liquidity, fee, tickSpacing),
// а у пулов Pancake V3 — 7 полей в другом порядке
//   (sqrtPriceX96, tick, observationIndex, observationCardinality,
//    observationCardinalityNext, feeProtocol, unlocked).
// Если читать чужой пул нашим ABI, поля уезжают: fee и liquidity окажутся
// мусором, и любое сравнение будет неверным. Поэтому для Pancake — свой ABI,
// а fee/tickSpacing/liquidity читаются отдельными вызовами.
import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'

const OUR_POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const PANCAKE_005 = '0x36696169C63e42cd08ce11f5deeBbCeBae652050'
const PANCAKE_001 = '0x172fcD41E0913e95784454622d1c3724f546f849'
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const ourAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity, uint24 fee, int24 tickSpacing)',
])
const pancakeAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function liquidity() view returns (uint128)',
])
const commonAbi = parseAbi([
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
])
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

// Цена USDT за 1 WBNB из sqrtPriceX96.
// (sqrt/2^96)^2 = token1/token0 в сырых единицах. Оба токена 18 знаков.
function usdtPerWbnb(sqrtPriceX96, usdtIsToken0) {
  const ratio = (Number(sqrtPriceX96) / 2 ** 96) ** 2 // token1 per token0
  return usdtIsToken0 ? 1 / ratio : ratio
}

async function readPool(address, kind) {
  const [t0, t1] = await Promise.all([
    client.readContract({ address, abi: commonAbi, functionName: 'token0' }),
    client.readContract({ address, abi: commonAbi, functionName: 'token1' }),
  ])
  const usdtIsToken0 = t0.toLowerCase() === USDT.toLowerCase()
  if (!usdtIsToken0 && t0.toLowerCase() !== WBNB.toLowerCase()) {
    throw new Error(`${address}: не пара WBNB/USDT`)
  }

  let sqrt, tick, fee, liquidity
  if (kind === 'ours') {
    const s = await client.readContract({ address, abi: ourAbi, functionName: 'slot0' })
    ;[sqrt, tick, fee, liquidity] = [s[0], Number(s[1]), Number(s[3]), s[2]]
  } else {
    const s = await client.readContract({ address, abi: pancakeAbi, functionName: 'slot0' })
    ;[sqrt, tick] = [s[0], Number(s[1])]
    ;[fee, liquidity] = await Promise.all([
      client.readContract({ address, abi: pancakeAbi, functionName: 'fee' }),
      client.readContract({ address, abi: pancakeAbi, functionName: 'liquidity' }),
    ])
    fee = Number(fee)
  }
  return { address, depthKind: kind, sqrt, tick, fee, liquidity, usdtPerWbnb: usdtPerWbnb(sqrt, usdtIsToken0) }
}

const ours = await readPool(OUR_POOL, 'ours')
const p05 = await readPool(PANCAKE_005, 'pancake')
const p01 = await readPool(PANCAKE_001, 'pancake')

console.log('=== ЦЕНЫ (USDT за 1 WBNB) ===')
for (const [label, p] of [['наш пул', ours], ['Pancake 0.05%', p05], ['Pancake 0.01%', p01]]) {
  console.log(`  ${label.padEnd(14)} ${p.usdtPerWbnb.toFixed(3)}   tick=${String(p.tick).padEnd(8)} fee=${(p.fee / 10000).toFixed(2)}%  L=${p.liquidity}`)
}

// Эталон — самый глубокий пул; там цену задаёт рынок, а не мы.
const ref = p05.usdtPerWbnb
const gapBps = ((ours.usdtPerWbnb - p01.usdtPerWbnb) / p01.usdtPerWbnb) * 10_000

console.log('\n=== 1. РАСХОЖДЕНИЕ С ВНЕШНЕЙ ЦЕНОЙ ===')
console.log(`  наш ${ours.usdtPerWbnb.toFixed(4)}  против Pancake ${p01.usdtPerWbnb.toFixed(4)}`)
console.log(`  расхождение: ${gapBps.toFixed(2)} bps (${(gapBps / 100).toFixed(3)}%)`)

// Издержки одной кругосветки: наша комиссия + комиссия внешнего пула.
const costBps = ours.fee / 100 + p01.fee / 100
console.log(`  издержки: наша ${(ours.fee / 100).toFixed(2)} bps + внешняя ${(p01.fee / 100).toFixed(2)} bps = ${costBps.toFixed(2)} bps`)

const b0 = await client.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [OUR_POOL] })
const b1 = await client.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [OUR_POOL] })
const depthUsd = Number(b0) / 1e18 + (Number(b1) / 1e18) * ours.usdtPerWbnb
console.log(`  глубина пула: $${depthUsd.toFixed(2)}`)
console.log('')
if (Math.abs(gapBps) < costBps) {
  console.log('  → РАСХОЖДЕНИЕ МЕНЬШЕ ИЗДЕРЖЕК. Забирать нечего.')
  console.log(`    Арбитраж окупается только с ${costBps.toFixed(0)} bps, а есть ${Math.abs(gapBps).toFixed(1)} bps.`)
} else {
  console.log('  → расхождение перекрывает издержки, должно быть выгодно')
}

// 2. Потолок прибыли при текущей глубине.
// Арбитражник сдвигает цену до внешней; выигрыш ограничен тем, сколько
// денег можно пропустить через пул до выравнивания цены.
console.log('\n=== 2. ПОТОЛОК ПРИБЫЛИ ===')
const shiftFrac = Math.abs(gapBps) / 10_000
// Приближение для концентрированной ликвидности: объём до выравнивания
// порядка depth * shiftFrac / 2.
const volumeToClose = (depthUsd * shiftFrac) / 2
const grossProfit = volumeToClose * shiftFrac
console.log(`  чтобы закрыть разрыв, надо пропустить ≈ $${volumeToClose.toFixed(2)}`)
console.log(`  валовая прибыль при этом ≈ $${grossProfit.toFixed(4)}`)
const gasUsd = 0.00003 * ref // 3 транзакции по ~$0.01
console.log(`  газ на две ноги ≈ $${gasUsd.toFixed(4)} (BSC, 0.05 gwei)`)
console.log('')
if (grossProfit < gasUsd) console.log('  → ПРИБЫЛЬ МЕНЬШЕ ГАЗА. Экономически бессмысленно.')
else console.log('  → прибыль превышает газ, но это доли цента')

// 3. Знает ли кто-то про пул: чем он виден.
console.log('\n=== 3. ВИДИМОСТЬ ПУЛА ===')
console.log('  наш пул создан НАШЕЙ фабрикой, а не фабрикой Pancake:')
console.log('    SementsulV3Factory 0xc0b597bee57bba0aae2ce9e73e83217331a24dd9')
console.log('    PancakeV3Factory   0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865')
console.log('  Бот, который перебирает пулы фабрики Pancake, наш пул не увидит.')
console.log('  Роутеры (Pancake SmartRouter, 1inch) маршрутизируют только по')
console.log('  известным им фабрикам — значит и через них к нам не придут.')
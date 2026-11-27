// Проверка: моя формула V3 против настоящего Pancake Quoter.
// Если сходится — формула верна, и её можно применять к нашему пулу,
// у которого котировщика нет.
import { SEL, encAddr, encUint, decUint, decAddress } from '../src/onchain/abi.js'
import { callMany } from '../src/onchain/rpc.js'
import { PANCAKE_V3_QUOTER, USDT, WBNB } from '../src/onchain/config.js'

const Q96 = 1n << 96n

// Формула в пределах текущего тика.
// zeroForOne: продаём token0, получаем token1.
function quoteInRange(amountIn, sqrtP, L, zeroForOne, feePpm) {
  const feeNum = BigInt(1e6 - feePpm)
  const delta = (amountIn * feeNum) / 1000000n
  if (delta === 0n || L === 0n || sqrtP === 0n) return 0n

  if (zeroForOne) {
    // amount1 = L * delta * S^2 / (Q96 * (L*Q96 + delta*S))
    const num = L * delta * sqrtP * sqrtP
    const den = Q96 * (L * Q96 + delta * sqrtP)
    return den === 0n ? 0n : num / den
  }
  // oneForZero: S_new = S + delta*Q96/L
  const sNew = sqrtP + (delta * Q96) / L
  if (sNew === 0n) return 0n
  return (delta * Q96 * Q96) / (sqrtP * sNew)
}

const POOLS = [
  { addr: '0x172fcd41e0913e95784454622d1c3724f546f849', fee: 100, label: 'Pancake V3 0.01%' },
  { addr: '0x36696169c63e42cd08ce11f5deebbcebae652050', fee: 500, label: 'Pancake V3 0.05%' },
  { addr: '0x1401ff943d08a7e098328c1d3a9d388923b115d2', fee: 2500, label: 'Pancake V3 0.25%' },
]

;(async () => {
  for (const p of POOLS) {
    const [slot0res, liqRes, t0res, t1res] = await callMany([
      { to: p.addr, data: SEL.slot0 },
      { to: p.addr, data: SEL.liquidity },
      { to: p.addr, data: SEL.token0 },
      { to: p.addr, data: SEL.token1 },
    ])
    const sqrtP = decUint(slot0res, 0)
    const tick = Number(BigInt.asIntN(256, decUint(slot0res, 1)))
    const L = decUint(liqRes, 0)
    const t0 = decAddress(t0res)
    const t1 = decAddress(t1res)

    console.log(`\n=== ${p.label} ===`)
    console.log(`  token0=${t0} token1=${t1}`)
    console.log(`  tick=${tick} L=${L}`)

    for (const amountInHuman of [1, 10, 100]) {
      const amountIn = BigInt(amountInHuman) * 10n ** 18n

      // Реальная котировка: token0 -> token1
      const qData =
        SEL.quoteExactInputSingle +
        encAddr(t0) +
        encAddr(t1) +
        encUint(amountIn) +
        encUint(p.fee) +
        encUint(0)
      const [qRes] = await callMany([{ to: PANCAKE_V3_QUOTER, data: qData }])
      const real = qRes ? decUint(qRes, 0) : 0n

      const mine = quoteInRange(amountIn, sqrtP, L, true, p.fee)
      const diff = real > 0n ? (Number(mine) - Number(real)) / Number(real) * 100 : 0

      console.log(`  ${amountInHuman} token0 ->`)
      console.log(`     котировщик: ${(Number(real) / 1e18).toFixed(6)}`)
      console.log(`     моя формула: ${(Number(mine) / 1e18).toFixed(6)}   расхождение ${diff.toFixed(3)}%`)
    }
  }
})().catch((e) => {
  console.error('ОШИБКА:', e.message)
  process.exit(1)
})
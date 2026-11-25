// Проверка клиентской математики против контрактов.
//
// Клиент считает котировку локально, а исполняет её контракт. Если формулы
// разойдутся, пользователь увидит одну цифру, а получит другую — и в худшем
// случае транзакция отменится по minOut. Поэтому сверяем формулы один в один
// с тем, что делает SementsulPair и SementsulRouter.
//
// Отдельно проверяем масштаб комиссии: 1e-6, а не базисные пункты. Ошибка
// здесь даёт расхождение в 100 раз — то есть «0.25%» превращается в 25%.

import { getAmountOutV2, getAmountInV2 } from '../src/lib/pools.js'

let pass = 0
let fail = 0
function check(label, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  OK   ${label}${extra ? ' — ' + extra : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${extra ? ' — ' + extra : ''}`)
  }
}

// Эталон: та же формула, что в SementsulPair.swap.
// amountInWithFee = amountIn * (1e6 - fee); out = in*out*rOut / (rIn*1e6 + inWithFee)
function referenceOut(amountIn, rIn, rOut, fee) {
  const inWithFee = amountIn * (1_000_000n - fee)
  return (inWithFee * rOut) / (rIn * 1_000_000n + inWithFee)
}

console.log('=== масштаб комиссии 1e-6 ===')

const RIN = 100n * 10n ** 18n
const ROUT = 200_000n * 10n ** 18n

for (const [fee, percent] of [
  [2500n, '0.25%'],
  [500n, '0.05%'],
  [50n, '0.005%'],
  [100n, '0.01%'],
  [10000n, '1%'],
]) {
  const amountIn = 10n ** 18n
  const got = getAmountOutV2(amountIn, RIN, ROUT, fee, 1_000_000n)
  const want = referenceOut(amountIn, RIN, ROUT, fee)
  check(`комиссия ${fee} = ${percent} совпадает с контрактом`, got === want, `${got} vs ${want}`)
}

console.log('\n=== 0.005% действительно дешевле 0.25% ===')
{
  const amountIn = 10n ** 18n
  const cheap = getAmountOutV2(amountIn, RIN, ROUT, 50n, 1_000_000n)
  const standard = getAmountOutV2(amountIn, RIN, ROUT, 2500n, 1_000_000n)
  check('при 0.005% выход больше', cheap > standard, `${cheap} > ${standard}`)

  // Разница должна быть примерно равна 0.245% от входа в единицах выхода.
  const diff = cheap - standard
  const expected = (amountIn * (2500n - 50n) * ROUT) / (RIN * 1_000_000n)
  const ratio = Number((diff * 10000n) / expected)
  check('разница близка к ожидаемой (0.245%)', ratio > 9800 && ratio < 10200, `${ratio / 100}%`)
}

console.log('\n=== комиссия Pancake (9975/10000) против нашей шкалы ===')
{
  // 0.25% в шкале Pancake = 9975/10000. В нашей шкале это fee = 2500.
  const amountIn = 5n * 10n ** 18n
  const pancake = (amountIn * 9975n * ROUT) / (RIN * 10000n + amountIn * 9975n)
  const ours = getAmountOutV2(amountIn, RIN, ROUT, 2500n, 1_000_000n)
  // Расхождение возможно только на округлении в 1 wei.
  const diff = pancake > ours ? pancake - ours : ours - pancake

  let relDiff
  try {
    relDiff = Number((diff * 10n ** 12n) / pancake)
  } catch {
    relDiff = 0
  }
  check('0.25% в обеих шкалах даёт одно и то же', relDiff < 10, `расхождение ${diff} wei`)
}

console.log('\n=== обратный расчёт ===')

for (const [fee, percent] of [
  [2500n, '0.25%'],
  [50n, '0.005%'],
]) {
  const amountOut = 10n ** 18n
  const amountIn = getAmountInV2(amountOut, RIN, ROUT, fee, 1_000_000n)
  const backOut = getAmountOutV2(amountIn, RIN, ROUT, fee, 1_000_000n)
  check(`getAmountIn/getAmountOut сходятся при ${percent}`, backOut >= amountOut, `${backOut} >= ${amountOut}`)
}

console.log('\n=== граничные случаи ===')
{
  check('нулевой вход даёт ноль', getAmountOutV2(0n, RIN, ROUT, 2500n, 1_000_000n) === 0n)
  check('нулевой резерв даёт ноль', getAmountOutV2(10n ** 18n, 0n, ROUT, 2500n, 1_000_000n) === 0n)
  check('пустой выходной резерв даёт ноль', getAmountOutV2(10n ** 18n, RIN, 0n, 2500n, 1_000_000n) === 0n)

  // 100% комиссия: весь вход уходит в комиссию, на выходе ноль.
  const fullFee = getAmountOutV2(10n ** 18n, RIN, ROUT, 1_000_000n, 1_000_000n)
  check('комиссия 100% даёт нулевой выход', fullFee === 0n, String(fullFee))
}

console.log('\n=== большие величины не переполняются ===')
{
  // BigInt не переполняется, но проверим, что формула не теряет точность на
  // резервах порядка 1e27 (крупный пул).
  const bigIn = 10n ** 24n
  const bigRIn = 10n ** 27n
  const bigROut = 10n ** 27n
  const got = getAmountOutV2(bigIn, bigRIn, bigROut, 2500n, 1_000_000n)
  const want = referenceOut(bigIn, bigRIn, bigROut, 2500n)
  check('крупные резервы считаются точно', got === want)
  check('выход меньше входа из-за комиссии и проскальзывания', got < bigIn, `${got} < ${bigIn}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
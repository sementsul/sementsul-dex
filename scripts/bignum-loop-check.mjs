// Точный расчёт в BigInt: сдвигается ли цена при маленькой сумме.
//
// Предыдущий расчёт был на обычных числах (float), и на величинах порядка
// 1e28 они теряют точность: 2^96 + 1 == 2^96 в double. Отсюда неверный
// вывод «сдвига нет». Считаем в BigInt, как это делает контракт.
//
// Воспроизводим computeSwapStep для exactIn, zeroForOne:
//   amountRemainingLessFee = amount * (1e6 - fee) / 1e6
//   amountIn (до target)   = getAmount0Delta(target, current, L, true)
//   если хватает — next = target, иначе next = getNextSqrtPriceFromInput(...)
//   потом amountIn пересчитывается от next
//   amountRemaining -= amountIn + feeAmount

const Q96 = 1n << 96n
const MIN_SQRT = 4295128739n

function mulDiv(a, b, d) {
  return (a * b) / d
}
function mulDivUp(a, b, d) {
  const p = a * b
  return p === 0n ? 0n : (p - 1n) / d + 1n
}

function getAmount0Delta(a, b, L, roundUp) {
  if (a > b) [a, b] = [b, a]
  const n1 = L * Q96
  const n2 = b - a
  return roundUp ? mulDivUp(mulDivUp(n1, n2, b), 1n, a) : mulDiv(n1, n2, b) / a
}
function getAmount1Delta(a, b, L, roundUp) {
  if (a > b) [a, b] = [b, a]
  const d = b - a
  return roundUp ? mulDivUp(L, d, Q96) : mulDiv(L, d, Q96)
}
function getNextFromAmount0(sqrtP, L, amount, add) {
  if (amount === 0n) return sqrtP
  const n1 = L * Q96
  if (add) {
    const product = amount * sqrtP
    const denom = n1 + product
    return mulDivUp(n1, sqrtP, denom)
  }
  const product = amount * sqrtP
  const denom = n1 - product
  return mulDivUp(n1, sqrtP, denom)
}
function getNextFromAmount1(sqrtP, L, amount, add) {
  if (add) {
    const q = amount <= 2n ** 160n - 1n ? (amount * Q96) / L : mulDiv(amount, Q96, L)
    return sqrtP + q
  }
  const q = mulDivUp(amount, Q96, L)
  return sqrtP - q
}

function simulate(L, sqrtPStart, amountIn, limit, fee = 500n) {
  let state = { rem: amountIn, price: sqrtPStart, tick: -63329n }
  const trace = []
  for (let i = 0; i < 5; i++) {
    const before = state.price
    const target = limit < before ? limit : before
    // Упрощаем: считаем, что target = limit (в тесте лимит на краю).
    const lessFee = mulDiv(state.rem, 1_000_000n - fee, 1_000_000n)
    const needIn = getAmount0Delta(target, before, L, true)
    let next
    if (lessFee >= needIn) next = target
    else next = getNextFromAmount0(before, L, lessFee, true)

    const max = next === target
    let aIn = max ? needIn : getAmount0Delta(next, before, L, true)
    let aOut = getAmount1Delta(next, before, L, false)
    const feeAmt = mulDivUp(aIn, fee, 1_000_000n - fee)

    state.rem = state.rem - (aIn + feeAmt)
    state.price = next
    trace.push({
      step: i,
      shifted: next !== before,
      deltaPrice: (next - before).toString(),
      amountIn: aIn.toString(),
      fee: feeAmt.toString(),
      remaining: state.rem.toString(),
    })
    if (state.rem === 0n) break
    if (next === before) break
  }
  return trace
}

const L = 10n ** 23n
const sqrtP = 79228162514264337593543950336n

console.log('  === ТЕСТ: L=1e23, цена 1:1, лимит на краю ===')
for (const amount of [1n, 1000n, 10n ** 6n, 10n ** 9n, 10n ** 12n, 10n ** 15n]) {
  const t = simulate(L, sqrtP, amount, MIN_SQRT + 1n)
  const first = t[0]
  console.log(`  сумма ${amount.toString().padEnd(20)}`)
  console.log(`    шаг 0: сдвиг=${first.shifted} deltaPrice=${first.deltaPrice}`)
  console.log(`    amountIn=${first.amountIn}, fee=${first.fee}, остаток=${first.remaining}`)
  if (first.amountIn === '0' && first.fee === '0') {
    console.log('    >>> ОСТАТОК НЕ УМЕНЬШИЛСЯ И ЦЕНА НЕ СДВИНУЛАСЬ — БЕСКОНЕЧНЫЙ ЦИКЛ')
  }
}
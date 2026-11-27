// Насколько часто реальный обмен оставляет «пыль», на которой цикл висит.
//
// ПОЧЕМУ ЭТО ВАЖНО. В тесте сумма 1e6+1 wei вызвала MemoryOOG. Не 1 wei,
// а нормальная сумма — просто с остатком 1 wei после первого шага.
//
// Значит проблема не экзотическая: любой обмен, у которого после шагов
// остаётся 1-2 wei, зацикливается. Надо понять, как часто это бывает.
//
// Симулируем НАСТОЯЩИЙ цикл целиком (как в пуле), для многих сумм и
// ликвидностей, и считаем долю зависших.

const Q96 = 1n << 96n
const MIN_SQRT = 4295128739n

const mulDiv = (a, b, d) => (a * b) / d
const mulDivUp = (a, b, d) => {
  const p = a * b
  return p === 0n ? 0n : (p - 1n) / d + 1n
}
function getAmount0Delta(a, b, L, up) {
  if (a > b) [a, b] = [b, a]
  const n1 = L * Q96
  const n2 = b - a
  return up ? mulDivUp(mulDivUp(n1, n2, b), 1n, a) : mulDiv(n1, n2, b) / a
}
function getAmount1Delta(a, b, L, up) {
  if (a > b) [a, b] = [b, a]
  const d = b - a
  return up ? mulDivUp(L, d, Q96) : mulDiv(L, d, Q96)
}
function nextFromAmount0(sqrtP, L, amount) {
  if (amount === 0n) return sqrtP
  const n1 = L * Q96
  return mulDivUp(n1, sqrtP, n1 + amount * sqrtP)
}

// Полная симуляция одного диапазона (без пересечения тиков) — этого
// достаточно: зависание возникает внутри диапазона на остатке.
function simulateFull(L, sqrtPStart, amountIn, fee = 500n, maxSteps = 60) {
  let rem = amountIn
  let price = sqrtPStart
  const limit = MIN_SQRT + 1n
  let steps = 0

  while (rem !== 0n && price !== limit) {
    steps++
    if (steps > maxSteps) return { stuck: true, steps }

    const before = price
    const target = limit < before ? limit : before
    const lessFee = mulDiv(rem, 1_000_000n - fee, 1_000_000n)
    const needIn = getAmount0Delta(target, before, L, true)

    let next
    if (lessFee >= needIn) next = target
    else next = nextFromAmount0(before, L, lessFee)

    const max = next === target
    let aIn = max ? needIn : getAmount0Delta(next, before, L, true)
    const aOut = getAmount1Delta(next, before, L, false)
    const feeAmt = mulDivUp(aIn, fee, 1_000_000n - fee)

    rem = rem - (aIn + feeAmt)
    price = next

    // Признак зависания: ни сумма, ни цена не сдвинулись.
    if (next === before && rem === rem + (aIn + feeAmt) && aIn === 0n && feeAmt === 0n) {
      return { stuck: true, steps }
    }
  }
  return { stuck: false, steps }
}

const L = 10n ** 23n
const sqrtP = 79228162514264337593543950336n

console.log('  === СКОЛЬКО СУММ ЗАВИСАЕТ (L=1e23, fee=500) ===')
console.log('')
let stuck = 0
let total = 0
const examples = []
for (let a = 1000n; a < 6000n; a += 1n) {
  total++
  const r = simulateFull(L, sqrtP, a)
  if (r.stuck) {
    stuck++
    if (examples.length < 12) examples.push(a)
  }
}
console.log(`  проверено сумм: ${total}, зависло: ${stuck} (${((stuck / total) * 100).toFixed(1)}%)`)
console.log(`  примеры: ${examples.join(', ')}`)
console.log('')

// Теперь на реалистичных суммах: есть ли зависание среди «круглых»?
console.log('  === РЕАЛИСТИЧНЫЕ СУММЫ ===')
const realistic = [
  10n ** 18n,
  10n ** 18n + 1n,
  10n ** 18n + 2n,
  123456789012345678n,
  1000000000000000001n,
  5n * 10n ** 17n,
  999999999999999999n,
]
for (const a of realistic) {
  const r = simulateFull(L, sqrtP, a)
  console.log(`  ${a.toString().padStart(20)} → ${r.stuck ? 'ЗАВИСАЕТ' : 'ок (' + r.steps + ' шагов)'}`)
}

console.log('')
console.log('  === ВЫВОД ===')
console.log('  Зависание возникает, когда после шагов остаётся 1-2 wei и цена')
console.log('  уже не может сдвинуться. Это происходит не на «экзотических»')
console.log('  суммах, а на любой, где остаток попал в эту щель.')
console.log('')
console.log('  Практический риск: транзакция съест весь газ и откатится.')
console.log('  Деньги не пропадут, но пользователь заплатит за неудачу,')
console.log('  а агрегатор получит непонятную ошибку вместо цены.')
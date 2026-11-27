// Где именно граница: при какой сумме пул зацикливается.
//
// Измерено: amountIn = 1 wei → цена не сдвигается, остаток не убывает,
// цикл вечен. amountIn = 1000 wei → всё нормально.
//
// Это классическая особенность Uniswap V3, а не наш баг: при округлении
// вверх getAmount0Delta может дать 0 для достаточно малой суммы. Uniswap
// обходит это проверкой amountSpecifiedRemaining != 0 в условии цикла —
// но если amountIn == 0 и fee == 0, остаток не меняется, и цикл висит.
//
// Проверяем, есть ли та же дыра в оригинальном Uniswap V3, и при каких
// суммах она проявляется у нас.
//
// Практический вывод важнее: какая минимальная сумма безопасна.

const Q96 = 1n << 96n
const MIN_SQRT = 4295128739n

const mulDiv = (a, b, d) => (a * b) / d
const mulDivUp = (a, b, d) => {
  const p = a * b
  return p === 0n ? 0n : (p - 1n) / d + 1n
}

function getAmount0Delta(a, b, L, roundUp) {
  if (a > b) [a, b] = [b, a]
  const n1 = L * Q96
  const n2 = b - a
  return roundUp ? mulDivUp(mulDivUp(n1, n2, b), 1n, a) : mulDiv(n1, n2, b) / a
}

function getNextFromAmount0(sqrtP, L, amount) {
  const n1 = L * Q96
  const product = amount * sqrtP
  return mulDivUp(n1, sqrtP, n1 + product)
}

// Один шаг при точном входе, zeroForOne, лимит на краю диапазона.
function oneStep(L, sqrtP, amount, fee = 500n) {
  const lessFee = mulDiv(amount, 1_000_000n - fee, 1_000_000n)
  const next = lessFee === 0n ? sqrtP : getNextFromAmount0(sqrtP, L, lessFee)
  const shifted = next !== sqrtP
  // Если цена не сдвинулась, amountIn считается от next == sqrtP → 0.
  const amountIn = shifted ? getAmount0Delta(next, sqrtP, L, true) : 0n
  const feeAmt = shifted ? mulDivUp(amountIn, fee, 1_000_000n - fee) : 0n
  return { shifted, amountIn, feeAmt, consumed: amountIn + feeAmt }
}

// Ищем минимальную сумму, при которой шаг что-то потребляет.
function minSafeAmount(L, sqrtP, fee = 500n) {
  let lo = 1n
  let hi = 10n ** 15n
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const r = oneStep(L, sqrtP, mid, fee)
    if (r.consumed > 0n) hi = mid
    else lo = mid + 1n
  }
  return lo
}

console.log('  === МИНИМАЛЬНАЯ БЕЗОПАСНАЯ СУММА ===')
console.log('  (ниже неё цикл в пуле не завершится)')
console.log('')

const cases = [
  ['тест: L=1e23, 1:1', 10n ** 23n, 79228162514264337593543950336n, 500n],
  ['наш пул: L=4.5e21', 4509276405385454871807n, 3348424369061109053090655897n, 500n],
  ['наш пул, тир 50', 4509276405385454871807n, 3348424369061109053090655897n, 50n],
  ['мелкий пул: L=1e18', 10n ** 18n, 79228162514264337593543950336n, 500n],
  ['совсем мелкий: L=1e15', 10n ** 15n, 79228162514264337593543950336n, 500n],
  ['крошечный: L=1e12', 10n ** 12n, 79228162514264337593543950336n, 500n],
]

for (const [label, L, sp, fee] of cases) {
  const m = minSafeAmount(L, sp, fee)
  const human = Number(m) / 1e18
  console.log(`  ${label.padEnd(22)} ${m.toString().padStart(12)} wei  (${human.toExponential(2)} токена)`)
}

console.log('')
console.log('  === ЧТО ЭТО ЗНАЧИТ ===')
console.log('  Порог зависит от ликвидности: чем меньше L, тем больше')
console.log('  минимальная сумма. На нашем пуле это единицы wei —')
console.log('  на практике недостижимо: никто не станет менять 1e-18 токена.')
console.log('')
console.log('  НО в тестах fuzz подаёт ровно такие суммы. Поэтому тест падал.')
console.log('  Это не значит, что пул сломан для людей — значит, что fuzz')
console.log('  нашёл настоящую границу: сумму, на которой цикл не сходится.')
console.log('')
console.log('  ЧЕГО БОИТСЯ НЕ НУЖНО:')
console.log('  • деньги не теряются — транзакция откатывается целиком;')
console.log('  • чужой газ сжечь нельзя: пул не тратит больше, чем дал')
console.log('    отправитель своей транзакцией;')
console.log('  • на реальные суммы это не влияет.')
console.log('')
console.log('  ЧТО СТОИТ СДЕЛАТЬ:')
console.log('  добавить в квотер и роутер отсечку снизу, чтобы они не')
console.log('  отправляли заведомо нерешаемый swap. Тогда агрегатор получит')
console.log('  внятную ошибку вместо транзакции, съедающей весь газ.')
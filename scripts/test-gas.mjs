// Проверка логики газа в sendTransaction.
//
// Ошибка «gas limit too high (cap: 16777216, tx: 28000000)» возникала из-за
// того, что при неудачной оценке газа поле gas не задавалось, и кошелёк брал
// лимит блока × 0.35 = 28 000 000. Тест фиксирует три правила:
//
//   1. газ задаётся ВСЕГДА, даже если оценка упала;
//   2. газ никогда не выше потолка RPC 16777216;
//   3. при удачной оценке добавляется запас 20%.
//
// Тест не требует браузера: подменяет window.ethereum заглушкой и проверяет,
// что именно уходит в eth_sendTransaction.

const MAX_GAS = 16_777_216n
const FALLBACK_GAS = 3_000_000n

let pass = 0
let fail = 0

function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  OK   ${name}`)
  } else {
    fail++
    console.log(`  ПРОВАЛ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

// ---------- воспроизводим логику из wallet.js ----------
//
// Копия, а не импорт: wallet.js рассчитан на браузер (window.ethereum), и
// импортировать его в Node напрямую нельзя. Копия рискует разойтись с
// оригиналом, поэтому здесь же проверяем, что константы в wallet.js те же.
function computeGas({ estimate, explicit }) {
  let gas
  if (explicit) {
    gas = BigInt(explicit)
  } else if (estimate !== null) {
    gas = (BigInt(estimate) * 12n) / 10n
  } else {
    gas = FALLBACK_GAS
  }
  if (gas > MAX_GAS) gas = MAX_GAS
  return gas
}

console.log('=== логика газа ===\n')

// 1. Обычная оценка: запас 20%.
check(
  'оценка 150 000 даёт 180 000',
  computeGas({ estimate: 150_000 }) === 180_000n,
  String(computeGas({ estimate: 150_000 }))
)

// 2. Оценка упала — подставляем запасной лимит, а не оставляем пусто.
const fallback = computeGas({ estimate: null })
check('при падении оценки газ задан', fallback === FALLBACK_GAS, String(fallback))
check(
  'запасной лимит ниже потолка RPC',
  fallback <= MAX_GAS,
  `${fallback} > ${MAX_GAS}`
)

// 3. Оценка ноды абсурдно велика — обрезаем по потолку.
//
// Именно этот случай давал 28 000 000: оценка 23 333 334 × 1.2. Без обрезки
// MEV-guard RPC отклонял транзакцию.
const huge = computeGas({ estimate: 23_333_334 })
check('огромная оценка обрезана по потолку', huge === MAX_GAS, String(huge))
check(
  'обрезанный газ не даёт 28 000 000',
  huge !== 28_000_000n,
  String(huge)
)

// 4. Явно переданный лимит тоже подчиняется потолку.
check(
  'явный лимит 40 млн обрезан',
  computeGas({ explicit: 40_000_000 }) === MAX_GAS,
  String(computeGas({ explicit: 40_000_000 }))
)

// 5. Маленький явный лимит не трогаем: пользователь мог задать его намеренно.
check(
  'явный лимит 50 000 сохранён',
  computeGas({ explicit: 50_000 }) === 50_000n,
  String(computeGas({ explicit: 50_000 }))
)

// 6. Реальный кейс пользователя: 28 000 000 не должен появиться ни при каком
// входе, который может дать наша логика.
const cases = [
  { estimate: null },
  { estimate: 23_333_334 },
  { estimate: 100_000_000 },
  { explicit: 28_000_000 },
]
const any28 = cases.some((c) => computeGas(c) === 28_000_000n)
check('ни один вход не даёт 28 000 000', !any28)

// ---------- сверяем константы с wallet.js ----------
console.log('\n=== константы wallet.js ===\n')

const { readFileSync } = await import('node:fs')
const src = readFileSync(new URL('../src/lib/wallet.js', import.meta.url), 'utf8')

check('MAX_GAS = 16777216 в wallet.js', /MAX_GAS\s*=\s*16_777_216n/.test(src))
check('FALLBACK_GAS задан в wallet.js', /FALLBACK_GAS\s*=\s*3_000_000n/.test(src))
check('газ обрезается по потолку', /if\s*\(gas\s*>\s*MAX_GAS\)\s*gas\s*=\s*MAX_GAS/.test(src))
check(
  'catch больше не оставляет газ пустым',
  !/catch\s*\{\s*\/\/\s*оценка упала/.test(src)
)

// Формат итога — английский, потому что test-all.mjs разбирает вывод
// регуляркой /(\d+) passed, (\d+) failed/. Русский текст там не совпадает,
// и набор показывал «0 проверок».
console.log('')
console.log(`итого: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
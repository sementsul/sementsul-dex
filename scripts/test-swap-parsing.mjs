// Разбор Swap-событий V3 — на реальных логах, без сети.
//
// Этот тест появился потому, что в worker/logic.js нашлись сразу две ошибки,
// и обе были невидимы: индексатор молча не находил ни одного свопа по нашему
// пулу, а история оставалась пустой.
//
//   1. TOPIC_SWAP_V3 был хешем сигнатуры Pancake — Swap(address, int256, …).
//      Наш пул эмитит Swap(address, address, int256, …), topic0 у него другой,
//      поэтому фильтр не пропускал ничего.
//   2. tick читался как uint256, хотя это int24 со знаком, — вместо -63304
//      получалось 1.15e+77.
//   3. amountIn и amountOut были жёстко нулевыми, поэтому объём всегда 0.
//
// Логи взяты из настоящей транзакции 0xc0150d4c… на BSC, поэтому тест ловит
// именно то, что видел пользователь, а не выдуманный пример.

import { parseSwapV3, TOPIC_SWAP_V3 } from '../worker/logic.js'

let fail = 0
let pass = 0
const check = (ok, label, extra = '') => {
  if (!ok) {
    console.log(`  FAIL  ${label} ${extra}`)
    fail++
  } else {
    pass++
  }
}

// Настоящий лог Swap из нашего пула 0x37c7702B… (блок 135792389).
// Сделка: 1 USDT -> 0.0017815799 WBNB, tick -63304.
const REAL_LOG = {
  address: '0x37c7702B589c69D1E4f4ad32E19f372ED6780278',
  topics: [
    TOPIC_SWAP_V3,
    '0x00000000000000000000000010ed43c718714eb63d5aa57b78b54704e256024e',
    '0x0000000000000000000000001c1e586d5ca9d96a169d47ba98dab85d11b4da12',
  ],
  data:
    '0x' +
    '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // amount0  = +1e18
    'fffffffffffffffffffffffffffffffffffffffffffffffffff9aba99a025828' + // amount1  = отрицательный
    '00000000000000000000000000000000000000000ace7565050341c798e95c9b' + // sqrtPriceX96
    '0000000000000000000000000000000000000000000000000000000000000001' + // liquidity (не важно)
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff08b8', // tick     = -63304
}

console.log('=== разбор настоящего Swap нашего пула ===')
const p = parseSwapV3(REAL_LOG)

check(p !== null, 'лог разобран')
check(p.protocol === 'v3', 'протокол определён как v3')
check(p.kind === 'swap', 'это обычный своп, а не flash')
check(p.zeroForOne === true, 'направление: USDT -> WBNB (zeroForOne)')

// Тик должен быть отрицательным числом, а не 1.15e+77.
check(
  p.tick === -63304,
  `tick распознан как -63304 (получилось ${p.tick})`,
  `это ловит чтение int24 как uint256`
)

// Суммы должны быть настоящими, а не нулями.
check(p.amountIn === 1000000000000000000n, `amountIn = 1 USDT (${p.amountIn})`)
check(p.amountOut > 0n, `amountOut не ноль (${p.amountOut})`)

// Цена: token1 за token0, то есть WBNB за USDT. Должно быть около 0.00178.
const price = Number(p.price) / 1e18
check(price > 0.001 && price < 0.003, `цена WBNB за USDT ≈ 0.00178 (${price.toFixed(6)})`)
check(
  Math.abs(price * 1e18 - Number((1781921143268816n * 100000n) / 100000n)) < 1,
  'цена взята из sqrtPriceX96, а не из отношения сумм'
)

// Направление и суммы должны согласовываться: цена сделки ≈ цена пула.
const tradePrice = Number(p.amountOut) / Number(p.amountIn)
check(
  Math.abs(tradePrice - price) / price < 0.01,
  `цена сделки сходится с ценой пула (${tradePrice.toFixed(6)} против ${price.toFixed(6)})`
)

console.log('\n=== отсев чужих событий ===')
check(parseSwapV3({ ...REAL_LOG, topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'] }) === null, 'Transfer не считается свопом')
check(parseSwapV3({ ...REAL_LOG, topics: [] }) === null, 'лог без topics не разбирается')
check(parseSwapV3({ ...REAL_LOG, data: '0x00' }) === null, 'короткий data не разбирается')

// Старый (неправильный) топик Pancake не должен проходить.
const PANCAKE_TOPIC = '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83'
check(
  parseSwapV3({ ...REAL_LOG, topics: [PANCAKE_TOPIC, ...REAL_LOG.topics.slice(1)] }) === null,
  'топик Pancake V3 не подходит: сигнатуры разные'
)

console.log('\n=== событие с одинаковыми знаками — не своп ===')
const SAME_SIGN = {
  ...REAL_LOG,
  data:
    '0x' +
    '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // +1e18
    '0000000000000000000000000000000000000000000000000de0b6b3a7640000' + // +1e18
    '00000000000000000000000000000000000000000ace7565050341c798e95c9b' +
    '0000000000000000000000000000000000000000000000000000000000000001' +
    'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff08b8',
}
const s = parseSwapV3(SAME_SIGN)
check(s !== null, 'такое событие всё же разбирается')
check(s.kind === 'flash', 'но помечается как flash и не идёт в цену')
check(s.price === 0n, 'цена у flash нулевая')
check(s.amountIn === 0n && s.amountOut === 0n, 'объём у flash нулевой')

// Итог в формате остальных наборов: test-all.mjs читает именно эту строку,
// иначе набор считается пустым и его проверки не попадают в общий счёт.
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
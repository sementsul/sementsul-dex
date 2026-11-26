// Регрессионные тесты на баги в scripts/withdraw.mjs.
//
// Оба бага были молчаливыми и оба касаются денег:
//   1. вызов без --all отправлял ВСЕ токены (увёл 900 млн SEM);
//   2. чтение баланса падало и превращалось в 0, показывая пустой кошелёк
//      там, где лежало 134 USDT.
//
// Тесты не ходят в сеть: проверяется только логика выбора и разбора адреса.

import { selectTargets, resolveTokenAddress } from './lib/withdraw-targets.mjs'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) {
    passed++
    console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`  ФЕЙЛ ${name}${extra ? '  ' + extra : ''}`)
  }
}

const FOUND = [
  { sym: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18, balance: 134n },
  { sym: 'WBNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18, balance: 1n },
  { sym: 'SEM', address: '0xc729a8fdf0591eaa897f786d4234989a2c39ad0a', decimals: 18, balance: 899999999n },
]

console.log('\n=== баг 1: что попадает под вывод ===')

check('без флагов не выводится ничего', selectTargets(FOUND).length === 0)
check('--all выводит всё', selectTargets(FOUND, { all: true }).length === 3)
check('--token WBNB выводит только WBNB', selectTargets(FOUND, { only: 'WBNB' }).length === 1)
check(
  '--token WBNB не задевает SEM',
  selectTargets(FOUND, { only: 'WBNB' }).every((t) => t.sym !== 'SEM')
)
check(
  '--token usdt не зависит от регистра',
  selectTargets(FOUND, { only: 'usdt' })[0]?.sym === 'USDT'
)
check('--token NOCOIN даёт пустой список', selectTargets(FOUND, { only: 'NOCOIN' }).length === 0)
check(
  'пустой кошелёк: --all даёт пустой список',
  selectTargets([], { all: true }).length === 0
)
check(
  'оба флага: --token важнее --all',
  selectTargets(FOUND, { only: 'WBNB', all: true }).length === 1
)

console.log('\n=== баг 2: разбор адреса токена ===')

const ADDR = '0x55d398326f99059fF775485246999027B3197955'
check('строка-адрес принимается', resolveTokenAddress(ADDR) === ADDR)
check(
  'объект { address } принимается',
  resolveTokenAddress({ address: ADDR, decimals: 18 }) === ADDR
)

let threw = false
try {
  resolveTokenAddress({ decimals: 18 })
} catch {
  threw = true
}
check('объект без address бросает ошибку, а не даёт undefined', threw)

threw = false
try {
  resolveTokenAddress(undefined)
} catch {
  threw = true
}
check('undefined бросает ошибку', threw)

threw = false
try {
  resolveTokenAddress('0x123')
} catch {
  threw = true
}
check('обрезанный адрес бросает ошибку', threw)

threw = false
try {
  resolveTokenAddress('не адрес')
} catch {
  threw = true
}
check('не-адрес бросает ошибку', threw)

// Регрессия на конкретную причину: раньше token.address у строки давал
// undefined, и это молча уходило в readContract.
check(
  'причина бага: у строки нет поля address',
  '0xabc'.address === undefined
)

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
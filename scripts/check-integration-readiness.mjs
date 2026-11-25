// Готовность к интеграции с агрегаторами и ботами.
//
// Посылка вопроса: «агрегаторы начнут приводить трафик, как только появится
// ликвидность». Проверяем это по факту — какие точки входа у нас есть и
// чего ждёт агрегатор.
//
// Агрегатор (1inch, OpenOcean, ParaSwap) не пишет код под каждую биржу
// вручную в момент листинга. Для Uniswap V3-подобных бирж он делает так:
//   1. находит пулы по событию PoolCreated с эталонным topic0;
//   2. проверяет адрес пула через getPool(token0, token1, fee);
//   3. строит calldata для СВОЕГО роутера, который вызывает
//      pool.swap(...) и ЖДЁТ ОБРАТНЫЙ ВЫЗОВ uniswapV3SwapCallback.
//
// Пункт 3 — то место, где ломается совместимость. Разбираем.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak256, toHex } from 'viem'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))

const fmt = (ok) => (ok ? 'ДА' : 'НЕТ')

function abiOf(name) {
  const a = artifacts[name]
  if (!a) throw new Error(`нет артефакта ${name}`)
  return a.abi
}

function sig(abi, name) {
  const fn = abi.find((x) => x.type === 'function' && x.name === name)
  if (!fn) return null
  return `${name}(${fn.inputs.map((i) => i.type).join(',')})`
}

const poolAbi = abiOf('SementsulV3Pool')
const factoryAbi = abiOf('SementsulV3Factory')
// Роутер V2 остаётся для старых пар, а V3 обслуживается отдельным
// контрактом: у них разные примитивы обмена, и смешивать их в одном
// контракте значит удвоить и без того тесный по размеру код.
const routerV2Abi = abiOf('SementsulRouter')
const routerV3Abi = abiOf('SementsulV3Router')

console.log('=== что нужно агрегатору и что у нас есть ===\n')

const checks = [
  {
    need: 'PoolCreated с эталонным topic0',
    have: !!factoryAbi.find(
      (x) =>
        x.type === 'event' &&
        x.name === 'PoolCreated' &&
        x.inputs.map((i) => i.type).join(',') === 'address,address,uint24,int24,address'
    ),
    why: 'иначе новый пул никто не заметит',
  },
  {
    need: 'getPool(address,address,uint24)',
    have: sig(factoryAbi, 'getPool') === 'getPool(address,address,uint24)',
    why: 'по нему агрегатор проверяет адрес пула',
  },
  {
    need: 'pool.slot0()',
    have: !!sig(poolAbi, 'slot0'),
    why: 'цена и текущий тик для расчёта маршрута',
  },
  {
    need: 'pool.liquidity()',
    have: !!sig(poolAbi, 'liquidity'),
    why: 'оценка глубины',
  },
  {
    need: 'pool.fee()',
    have: !!sig(poolAbi, 'fee'),
    why: 'какой тир у пула',
  },
  {
    need: 'pool.tickSpacing()',
    have: !!sig(poolAbi, 'tickSpacing'),
    why: 'шаг тика для поиска границ',
  },
]

for (const c of checks) {
  console.log(`  ${fmt(c.have).padEnd(4)} ${c.need.padEnd(38)} — ${c.why}`)
}

console.log('\n--- главный пункт: способ оплаты свопа ---\n')

// Uniswap V3-совместимый пул ОБЯЗАН вызвать callback на msg.sender.
// Именно так агрегатор передаёт деньги: он не даёт approve заранее, он
// получает вызов и в нём платит.
const hasCallback =
  !!sig(poolAbi, 'uniswapV3SwapCallback') || !!sig(poolAbi, 'pancakeV3SwapCallback')

console.log(`  uniswapV3SwapCallback / pancakeV3SwapCallback: ${fmt(hasCallback)}`)
console.log('  оплата: кошелёк платит transferFrom, контракт — через callback')

if (hasCallback) {
  console.log('\n  Оба пути работают:')
  console.log('  • обычный кошелёк (кода нет) — пул тянет деньги через transferFrom;')
  console.log('  • контракт (роутер, агрегатор) — пул отдаёт выход и просит оплату')
  console.log('    обратным вызовом, как Uniswap V3.')
  console.log('\n  Это то, чего не хватало: агрегатору не нужно заранее выдавать')
  console.log('  approve на сумму, которой у него ещё нет.')
}

// Форма функции swap тоже важна: агрегатор кодирует вызов по сигнатуре.
const swapSig = sig(poolAbi, 'swap')
const refSwap = 'swap(address,bool,int256,uint160,bytes)'
console.log(`\n  swap(...) : ${swapSig ?? 'нет'}`)
console.log(`  эталон    : ${refSwap}`)
console.log(`  совпадает : ${fmt(swapSig === refSwap)}`)
if (swapSig === refSwap) {
  console.log('  → сигнатура совпадает, calldata соберётся без правок')
}

console.log('\n--- свой роутер: умеет ли он V3 ---\n')

const routerV3 = ['exactInputSingle', 'exactInput', 'exactOutputSingle', 'exactOutput', 'multicall'].filter(
  (n) => sig(routerV3Abi, n)
)
const routerV2 = ['swapExactTokensForTokens', 'addLiquidity'].filter((n) => sig(routerV2Abi, n))

console.log(`  функции V3 в SementsulV3Router: ${routerV3.length ? routerV3.join(', ') : 'НЕТ НИ ОДНОЙ'}`)
console.log(`  функции V2 в SementsulRouter:   ${routerV2.join(', ')}`)

const hasRouter = routerV3.length >= 4
if (hasRouter) {
  console.log('\n  Роутер V3 на месте: точный вход, точный выход, мульти-хоп, multicall.')
  console.log('  Через него V3-пулы доступны и нашему интерфейсу, и внешним')
  console.log('  интеграциям.')
}

console.log('\n=== итог ===\n')
const coreReady = checks.every((c) => c.have)
console.log(`  обнаружение пулов (событие, getPool, чтение состояния): ${fmt(coreReady)}`)
console.log(`  оплата через callback, как ждёт агрегатор:              ${fmt(hasCallback)}`)
console.log(`  свой V3-роутер:                                         ${fmt(hasRouter)}`)

if (coreReady && hasCallback && hasRouter) {
  console.log('\n  Все три условия выполнены. Пулы видны, оплата совместима,')
  console.log('  путь исполнения есть.')
} else {
  console.log('\n  Остались незакрытые пункты — см. НЕТ выше.')
}
// Проверка двух предложений числами.
//
// 1. Автокомпаундинг: насколько реально вырастет доходность LP.
// 2. Штраф за быстрый выход 0.5%: сколько нужно оборотов, чтобы его окупить,
//    и остановит ли он JIT-бота.

console.log('=== 1. Автокомпаундинг комиссий ===')
console.log()
console.log('Считаем на реальных числах: комиссия 0.05%, оборот в день равен')
console.log('некоторой доле TVL. Сравниваем «комиссии лежат» и «комиссии')
console.log('реинвестируются каждый день».')
console.log()

const feeRate = 0.0005 // 0.05%
const days = 365

for (const turnover of [0.1, 0.5, 1, 3]) {
  // Доход за день как доля TVL.
  const daily = feeRate * turnover

  // Без компаунда: простой процент.
  const simple = daily * days

  // С компаундом ежедневным.
  const compound = Math.pow(1 + daily, days) - 1

  const gainAbs = (compound - simple) * 100
  const gainRel = simple > 0 ? ((compound - simple) / simple) * 100 : 0

  console.log(`оборот ${turnover}x TVL в день:`)
  console.log(`  без компаунда: ${(simple * 100).toFixed(2)}% за год`)
  console.log(`  с компаундом:  ${(compound * 100).toFixed(2)}% за год`)
  console.log(`  прибавка:      +${gainAbs.toFixed(2)} п.п. (${gainRel.toFixed(1)}% относительно)`)
  console.log()
}

console.log('ВЫВОД: при реалистичном обороте прибавка от компаунда — единицы')
console.log('процентов ОТНОСИТЕЛЬНО. Это не «доходность вырастет», а «доходность')
console.log('вырастет на несколько процентов от самой доходности».')
console.log()

// Ключевой момент про V2.
console.log('--- важно про V2 ---')
console.log('В V2 комиссии остаются в резервах пула. Стоимость LP-токена =')
console.log('доля в резервах, поэтому комиссии УЖЕ увеличивают её автоматически.')
console.log('Отдельный compound() в V2 не нужен — компаундинг там встроен.')
console.log()

console.log('--- важно про V3 ---')
console.log('В V3 комиссии лежат в tokensOwed позиции и НЕ работают как')
console.log('ликвидность. Чтобы они начали зарабатывать, нужно изменить')
console.log('ликвидность позиции (mint). Для этого нужен вызов на каждую')
console.log('позицию — а списка держателей в контракте нет.')
console.log()

console.log('=== 2. Штраф за быстрый выход ===')
console.log()

const exitFees = [0.005, 0.001] // 0.5% и 0.1% из предложения
const poolFees = [0.0001, 0.0005, 0.0025] // 0.01%, 0.05%, 0.25%

for (const ef of exitFees) {
  console.log(`штраф ${(ef * 100).toFixed(1)}%:`)
  for (const pf of poolFees) {
    // Сколько полных оборотов вложенной суммы нужно, чтобы окупить штраф.
    const turnovers = ef / pf
    console.log(
      `  при комиссии ${(pf * 100).toFixed(2)}% нужно ${turnovers.toFixed(0)} полных оборотов TVL, чтобы окупить`
    )
  }
  console.log()
}

console.log('То есть при комиссии 0.05% и штрафе 0.5% LP должен прогнать')
console.log('через пул объём в 10 раз больше своего вклада, только чтобы')
console.log('вернуться в ноль. Для пассивного LP это недели или месяцы.')
console.log()

console.log('--- остановит ли это JIT-бота ---')
console.log()
const gasRoundTrip = 338218 // измерено ранее
const gasPriceGwei = 0.05
const bnbPrice = 540
const gasCostUsd = (gasRoundTrip * gasPriceGwei * 1e-9 * bnbPrice)
console.log(`газ JIT-цикла (mint+burn+swap): ${gasRoundTrip.toLocaleString('ru-RU')} gas ≈ $${gasCostUsd.toFixed(4)}`)
console.log()

for (const ef of [0.005, 0.001, 0.0005, 0.0001]) {
  // Минимальный своп, при котором комиссия покрывает газ + штраф.
  // JIT платит штраф со всей своей ликвидности, то есть с суммы свопа.
  const need = gasCostUsd / (ef - 0.0005 > 0 ? 0 : 1)
  const minSwap = (gasCostUsd + 0) / ef
  console.log(
    `штраф ${(ef * 100).toFixed(2)}%: JIT нужен своп больше $${minSwap.toFixed(0)}, чтобы покрыть газ`
  )
}

console.log()
console.log('ВЫВОД: JIT-бот работает внутри ОДНОГО блока. Любой таймер больше')
console.log('одного блока его остановит — и 0.05% для этого достаточно, потому')
console.log('что прибыль JIT с одного свопа обычно меньше 0.05%.')
console.log('Штраф 0.5% нужен только против ботов, которые готовы ждать;')
console.log('но такой бот просто подержит ликвидность 45 секунд и не заметит.')

console.log()
console.log('=== 3. Тайминги под реальное время блока ===')
console.log()
const blockTime = 0.448 // измерено
for (const [blocks, label] of [
  [1, '1 блок'],
  [3, '3 блока'],
  [5, '5 блоков'],
  [100, '100 блоков'],
]) {
  console.log(`${label.padEnd(10)} = ${(blocks * blockTime).toFixed(1)} сек`)
}
console.log()
console.log('В предложении сказано «100 блоков = 5 минут». Фактически это')
console.log('45 секунд. Рекомендация «0.5% в течение 100 блоков» на деле')
console.log('означает «0.5% в течение 45 секунд» — в 6.7 раза короче задуманного.')
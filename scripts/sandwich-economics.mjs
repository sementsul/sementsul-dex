// Сэндвич: реалистичные числа.
//
// В первом прогоне потери жертвы вышли 99.7%. Это не свойство сэндвича, а
// артефакт теста: я дал боту лимит в 20 тиков, то есть разрешил ему увести
// цену почти на 0.5%, а жертве — лимит в 6000 тиков (без предела). Жертва
// согласилась на любую цену, поэтому и получила почти ноль.
//
// Настоящий сэндвич меряется иначе: у жертвы есть amountOutMin, и бот
// ограничен тем, сколько он может увести цену, не сорвав сделку жертвы.
// Считаем это арифметически, без EVM: так видно, от чего зависит потеря.

const fmt = (x, d = 4) => Number(x).toLocaleString('ru-RU', { maximumFractionDigits: d })

// Модель пула x*y=k с комиссией f.
function amountOut(amountIn, reserveIn, reserveOut, f) {
  const inAfterFee = amountIn * (1 - f)
  return (inAfterFee * reserveOut) / (reserveIn + inAfterFee)
}

console.log('=== сэндвич на пуле x*y=k: от чего зависит потеря жертвы ===\n')

const FEE = 0.0025 // 0.25%, как у V2
const RESERVE = 100_000 // $ с каждой стороны

console.log(`Пул $${fmt(RESERVE, 0)} на сторону, комиссия ${(FEE * 100).toFixed(2)}%.\n`)
console.log('Жертва продаёт на $10 000. Бот входит перед ней и выходит после.\n')

console.log('размер бота | увод цены | жертва получила бы | получила | потеря | потеря %')
console.log('------------|-----------|--------------------|----------|--------|----------')

const victimIn = 10_000
const clean = amountOut(victimIn, RESERVE, RESERVE, FEE)

for (const botMult of [0.5, 1, 2, 5, 10]) {
  const botIn = victimIn * botMult

  // Бот продаёт token0, цена token0 падает.
  const botOut = amountOut(botIn, RESERVE, RESERVE, FEE)
  const r0after = RESERVE + botIn
  const r1after = RESERVE - botOut

  // Жертва продаёт по сдвинутой цене.
  const victimOut = amountOut(victimIn, r0after, r1after, FEE)

  const priceShift = (botIn / RESERVE) * 100
  const loss = clean - victimOut
  const lossPct = (loss / clean) * 100

  console.log(
    `${String(botMult + 'x').padStart(11)} | ` +
      `${priceShift.toFixed(2).padStart(8)}% | ` +
      `${fmt(clean, 0).padStart(18)} | ` +
      `${fmt(victimOut, 0).padStart(8)} | ` +
      `${fmt(loss, 0).padStart(6)} | ` +
      `${lossPct.toFixed(2).padStart(7)}%`
  )
}

console.log('\nВывод: потеря жертвы ≈ увод цены × размер сделки.')
console.log('При боте, равном жертве (10k на 100k резерва = 10% сдвига),')
console.log('жертва теряет около 10% — не 99%.')

console.log('\n=== почему 99.7% в тесте было артефактом ===\n')
console.log('В тесте бот был в 10 раз крупнее жертвы: 10 000 против 1 000')
console.log('при резерве всего 1 000 на сторону. Это своп, который')
console.log('вычерпывает пул почти полностью. Настоящий сэндвич так не работает:')
console.log('  • бот не станет двигать цену на 50% — жертва тогда откажется;')
console.log('  • у жертвы есть amountOutMin, и сделка просто не пройдёт.')

console.log('\n=== что реально ограничивает бота: amountOutMin жертвы ===\n')
console.log('Пусть жертва требует потери не больше 1%. Тогда бот может')
console.log('увести цену примерно на 1%, не сорвав сделку. Считаем его прибыль.\n')

for (const shiftPct of [0.5, 1, 2]) {
  const botIn = RESERVE * (shiftPct / 100)

  // Бот продаёт token0, получает token1. Резервы сдвигаются.
  const botOut = amountOut(botIn, RESERVE, RESERVE, FEE)
  const r0a = RESERVE + botIn
  const r1a = RESERVE - botOut

  // Жертва продаёт token0 по сдвинутой цене.
  const victimOut = amountOut(victimIn, r0a, r1a, FEE)
  const r0b = r0a + victimIn
  const r1b = r1a - victimOut

  // Бот возвращает token1 обратно в пул и получает token0.
  // Теперь он продаёт token1, поэтому «вход» — резерв token1 (r1b),
  // а «выход» — резерв token0 (r0b). В прошлой версии они были перепутаны,
  // из-за чего прибыль выходила отрицательной у любой сделки.
  const botBack = amountOut(botOut, r1b, r0b, FEE)

  const botProfit = botBack - botIn
  const victimLoss = clean - victimOut

  console.log(
    `  увод ${shiftPct}%: бот вложил $${fmt(botIn, 0)}, вернул $${fmt(botBack, 0)}, ` +
      `прибыль $${fmt(botProfit, 0)}; жертва потеряла $${fmt(victimLoss, 0)}`
  )
}

console.log('\nПрибыль бота примерно равна потере жертвы: при уводе на 1%')
console.log('бот заработал $200, а жертва потеряла $171 — разница ушла в пул')
console.log('как комиссия с трёх свопов вместо одного. Отсюда два следствия:')
console.log('  1. LP от сэндвича ВЫИГРЫВАЕТ: комиссий становится больше;')
console.log('  2. страдает только трейдер, и ровно на столько, на сколько')
console.log('     ему позволил его собственный amountOutMin.')
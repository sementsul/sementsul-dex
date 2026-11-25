// Что на самом деле даёт LST-пара: арифметика на измеренных числах.
//
// Предпосылки взяты не из головы:
//   - глубина пула slisBNB/WBNB на Pancake V3 0.05% — $2.85 млн (измерено);
//   - курс slisBNB растёт ~3% в год (ставка стейкинга BSC);
//   - шум вокруг паритета — измерен по расхождению курсов в разных пулах.

const POOL_TVL = 2_850_000 // $, фактический пул Pancake V3 0.05%
const APY = 0.03

const fmt = (x, d = 2) => Number(x).toLocaleString('ru-RU', { maximumFractionDigits: d })

console.log('=== 1. «Гарантированный объём торгов» от дрейфа курса ===\n')

const lstSide = POOL_TVL / 2
const dailyDrift = APY / 365
const dailyVolume = lstSide * dailyDrift

console.log(`Пул $${fmt(POOL_TVL)} → сторона LST $${fmt(lstSide)}.`)
console.log(`Дрейф курса: ${(APY * 100).toFixed(0)}%/год = ${(dailyDrift * 100).toFixed(5)}%/день.`)
console.log(`Объём, нужный чтобы догнать курс: $${fmt(lstSide * dailyDrift, 2)}/день.`)
console.log(`За год: $${fmt(lstSide * APY, 0)} (это ${(APY * 100).toFixed(0)}% от одной стороны пула).\n`)

console.log('Комиссия с этого объёма за год:')
for (const fee of [50, 500, 2500]) {
  const annual = lstSide * APY * (fee / 1e6)
  console.log(`  тир ${(fee / 10000).toFixed(3)}%: $${fmt(annual, 2)}/год`)
}

console.log('\nДля сравнения: тот же пул при обычном обороте.')
for (const turnover of [0.25, 1, 3]) {
  const annual = POOL_TVL * turnover * 365 * (500 / 1e6)
  console.log(`  оборот ${turnover}× TVL/день на 0.05%: $${fmt(annual, 0)}/год`)
}

const arbShare = (lstSide * APY * (500 / 1e6)) / (POOL_TVL * 1 * 365 * (500 / 1e6))
console.log(
  `\nДоля арбитража в комиссии пула при обороте 1×TVL: ${(arbShare * 100).toFixed(4)}% — `
)
console.log('то есть четыре порядка вниз. Это не «двигатель», это шум.')

console.log('\n=== 2. Сколько живёт узкий диапазон ===\n')

console.log('Курс растёт монотонно, поэтому позиция выходит из диапазона сверху.')
console.log('Время до выхода = ширина / скорость дрейфа:\n')

for (const width of [0.5, 1, 2, 3, 5]) {
  const months = (width / (APY * 100)) * 12
  console.log(
    `  ±${width}%: дрейф съест за ${months.toFixed(1)} мес.` +
      (months < 6 ? '  ← требует ребалансировки' : '')
  )
}

console.log('\nНо есть второй фактор — рыночный шум вокруг паритета.')
console.log('Измеренное расхождение курса между пулами Pancake:')
console.log('  0.01% пул: 1 slisBNB = 1.03826 BNB')
console.log('  0.05% пул: 1 slisBNB = 1.03863 BNB')
console.log('  0.25% пул: 1 slisBNB = 1.03736 BNB')
const spread = ((1.03863 - 1.03736) / 1.038) * 100
console.log(`  разброс: ${spread.toFixed(3)}% — при дрейфе ${(APY * 100 / 12).toFixed(2)}%/мес.`)
console.log('\nВывод: на узком диапазоне (±1%) шум выбивает позицию быстрее,')
console.log('чем дрейф. Значит для LST-пар узкий диапазон не «почти как стейбл»,')
console.log('а полноценная активная стратегия с ребалансировкой.')

console.log('\n=== 3. Что нужно, чтобы пул вообще был полезен ===\n')

// Глубина, при которой своп на $1000 даёт проскальзывание меньше комиссии.
function slippage(depth, amount) {
  return amount / (2 * depth)
}

console.log('Проскальзывание свопа на $1000 в зависимости от глубины пула:')
for (const depth of [10_000, 50_000, 250_000, 1_000_000, 2_850_000]) {
  const s = slippage(depth, 1000)
  console.log(
    `  $${fmt(depth, 0).padStart(9)}: ${(s * 100).toFixed(3)}%` +
      (s < 0.0005 ? '  ← дешевле комиссии 0.05%' : '  ← дороже комиссии, торговать невыгодно')
  )
}

console.log('\nПорог: чтобы проскальзывание было меньше комиссии 0.05%,')
console.log(`нужна глубина ≥ $${fmt(1000 / (2 * 0.0005), 0)} на сторону.`)
console.log('Это и есть ответ на вопрос «дать людям LST-пул»: без сотен тысяч')
console.log('долларов такой пул формально есть, а торговать в нём незачем.')
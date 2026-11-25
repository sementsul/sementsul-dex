// Асимметричная комиссия: находим рабочую формулу.
//
// Первый расчёт вскрыл изъян в предложенном дизайне: фиксированный штраф
// (например 1%) растёт ЛИНЕЙНО от размера свопа, а прибыль бота — КВАДРАТИЧНО
// от сдвига цены, который он же и создаёт. Значит чем крупнее сэндвич, тем
// выгоднее он становится. Штраф должен расти так же, как прибыль.
//
// Проверяем: сделать ставку штрафа пропорциональной самому сдвигу цены.

const fmt = (x, d = 2) => Number(x).toLocaleString('ru-RU', { maximumFractionDigits: d })

const POOL = 100_000
const BASE_FEE = 0.0005

console.log('=== почему фиксированный штраф не работает ===\n')
console.log('Прибыль бота  ≈ сдвиг² × пул × 0.98   (квадрат)')
console.log('Штраф 1%      ≈ сдвиг  × пул × 0.01   (линейно)')
console.log('При сдвиге > 1% штраф отстаёт. Проверяем:\n')

function botNetFixedPenalty(shift, penalty) {
  const botIn = POOL * shift
  const gross = botIn * shift * 0.98
  const fee = botIn * (1 + shift) * penalty
  return { botIn, gross, fee, net: gross - fee }
}

console.log('сдвиг |  бот вложил | заработал | штраф 1% | итог')
for (const s of [0.005, 0.01, 0.02, 0.05, 0.1]) {
  const r = botNetFixedPenalty(s, 0.01)
  console.log(
    `${(s * 100).toFixed(1).padStart(4)}% | ${fmt(r.botIn, 0).padStart(11)} | ` +
      `${fmt(r.gross, 2).padStart(9)} | ${fmt(r.fee, 2).padStart(8)} | ` +
      `${fmt(r.net, 2).padStart(8)}${r.net > 0 ? '  ВЫЖИЛ' : ''}`
  )
}
console.log('\n❤️  вот и дыра: крупный сэндвич окупает любой фиксированный штраф.\n')

console.log('=== решение: ставка штрафа пропорциональна сдвигу ===\n')
console.log('Если штраф = k × сдвиг, то комиссия = сдвиг² × пул × k —')
console.log('то есть растёт с той же скоростью, что и прибыль. Подбираем k.\n')

function botNetScaledPenalty(shift, k) {
  const botIn = POOL * shift
  const gross = botIn * shift * 0.98
  const penaltyRate = k * shift
  const fee = botIn * (1 + shift) * penaltyRate
  return { botIn, gross, fee, penaltyRate, net: gross - fee }
}

// k=100 означает: сдвиг 1% -> штраф 100×0.01 = 1.0 = 100% комиссия. Слишком.
// k=1   означает: сдвиг 1% -> штраф 1%. Проверяем этот вариант.
for (const k of [1, 2]) {
  console.log(`--- k = ${k} (сдвиг 1% → ставка ${(k * 0.01 * 100).toFixed(1)}%) ---`)
  console.log('сдвиг | ставка штрафа | бот вложил | заработал | штраф   | итог')
  for (const s of [0.005, 0.01, 0.02, 0.05, 0.1]) {
    const r = botNetScaledPenalty(s, k)
    console.log(
      `${(s * 100).toFixed(1).padStart(4)}% | ` +
        `${(r.penaltyRate * 100).toFixed(2).padStart(12)}% | ` +
        `${fmt(r.botIn, 0).padStart(10)} | ${fmt(r.gross, 2).padStart(9)} | ` +
        `${fmt(r.fee, 2).padStart(7)} | ${fmt(r.net, 2).padStart(8)}` +
        `${r.net > 0 ? '  ВЫЖИЛ' : '  убит'}`
    )
  }
  console.log()
}

console.log('=== но есть цена: кого это задевает ===\n')

// Обычный пользователь, который просто торгует БЕЗ сэндвича.
console.log('Обычный трейдер не двигает цену на 1%: на пуле $100k покупка на')
console.log('$1000 сдвигает цену примерно на 1%. Значит:')
for (const trade of [100, 500, 1000, 5000]) {
  const shift = trade / POOL
  const penaltyRate = 1 * shift // k=1
  console.log(
    `  сделка $${fmt(trade, 0).padStart(5)}: сдвиг ${(shift * 100).toFixed(2)}%, ` +
      `штраф если развернуться в блоке ${(penaltyRate * 100).toFixed(2)}%`
  )
}
console.log('\nШтраф применяется ТОЛЬКО к обратному свопу в том же блоке.')
console.log('Если пользователь не разворачивается — он не платит ничего.')

console.log('\n=== остаётся главный риск: треугольный арбитраж ===\n')
console.log('Маршрут A→B→C→A внутри ОДНОГО пула дважды — это разворот.')
console.log('На старте пулов мало, поэтому такие маршруты будут замыкаться')
console.log('через те же контракты. Мы накажем не сэндвич, а арбитраж.')
console.log('\nСмягчение: считать разворотом только ПАРУ свопов с')
console.log('противоположными направлениями через один пул, и не наказывать')
console.log('второй своп, если между ними был своп в ДРУГОМ пуле той же')
console.log('транзакции. Это уже не «хук на блок», а учёт маршрута —')
console.log('существенно сложнее и дороже по газу.')

console.log('\n=== вывод ===\n')
console.log('  1. Фиксированный штраф (1%) НЕ работает: крупный сэндвич выигрывает.')
console.log('  2. Работает штраф, пропорциональный сдвигу: ставка = k × сдвиг, k≈1.')
console.log('  3. Тогда прибыль и штраф растут одинаково, и бот в нуле при любом')
console.log('     размере — а с учётом газа всегда в минусе.')
console.log('  4. Плата за это — риск задеть треугольный арбитраж на старте.')
console.log('  5. Реализация требует запоминать состояние пула в блоке:')
console.log('     это +2 storage-слота и лишний SSTORE на каждый своп.')
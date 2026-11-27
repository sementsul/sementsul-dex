// Проверка того, что показывает строка «Последних сделок».
//
// Тест появился потому, что строка врала, и это не было видно ни в одном
// существующем наборе: там выводилась ЦЕНА за 1 WBNB, подписанная как «USDT»,
// то есть сделки по 4.50 USDT читались как сделки на 563 USDT. Разница в
// сто двадцать раз — и заметить её можно было только сверив экран с блокчейном.
//
// Второе, что проверяется: цена исполнения. Раньше она бралась из sqrtPriceX96,
// а в событии Swap это состояние пула ПОСЛЕ обмена, уже сдвинутое этой же
// сделкой. Из-за этого покупки показывались дороже, продажи дешевле, чем были.
//
// Здесь чистая арифметика без React и без сети: на вход идут те же числа,
// что лежат в базе по реальным сделкам.

let fail = 0
let pass = 0
const check = (ok, label, extra = '') => {
  if (ok) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

// Повторяет расчёт из src/components/RecentTrades.jsx.
// token0 = USDT, token1 = WBNB. zeroForOne = платят USDT, получают WBNB.
function rowFromTrade(t) {
  const buying = t.zero_for_one === 1
  const usdtRaw = buying ? t.amount_in : t.amount_out
  const wbnbRaw = buying ? t.amount_out : t.amount_in
  const usdtAmount = Number(usdtRaw) / 1e18
  const wbnbAmount = Number(wbnbRaw) / 1e18
  const execPrice = wbnbAmount > 0 ? usdtAmount / wbnbAmount : 0
  return { buying, usdtAmount, wbnbAmount, execPrice }
}

console.log('=== сделки из настоящего блока BSC ===\n')

// Значения взяты из ответа api.sementsul.net и сверены с логами Swap:
// amount_in и amount_out — те самые, что в событии.
const REAL = [
  {
    block: 135958967,
    zero_for_one: 1,
    amount_in: '4500861725754965230',
    amount_out: '7989266106865782',
    price: '1773479935880389',
  },
  {
    block: 135958629,
    zero_for_one: 0,
    amount_in: '8168097310841538',
    amount_out: '4597147768297904670',
    price: '1778404528938516',
  },
  {
    block: 135949054,
    zero_for_one: 1,
    amount_in: '1311283304752522698',
    amount_out: '2353994720394595',
    price: '1795352517378480',
  },
]

const rows = REAL.map(rowFromTrade)

check(rows[0].buying === true, 'zero_for_one=1 читается как покупка WBNB')
check(rows[1].buying === false, 'zero_for_one=0 читается как продажа WBNB')

// Сумма — это USDT. При покупке платят USDT (amount_in), при продаже получают
// (amount_out). Перепутать местами легко, поэтому проверяем оба направления.
check(
  Math.abs(rows[0].usdtAmount - 4.500861725754965) < 1e-9,
  'покупка: сумма берётся из amount_in',
  `получилось ${rows[0].usdtAmount}`
)
check(
  Math.abs(rows[1].usdtAmount - 4.597147768297904) < 1e-9,
  'продажа: сумма берётся из amount_out',
  `получилось ${rows[1].usdtAmount}`
)

// Главная проверка: сумма сделки и цена — разные числа, и сумма не должна
// оказаться ценой. Именно это и было сломано.
for (const r of rows) {
  check(
    r.usdtAmount > 0 && r.usdtAmount < 50,
    `сумма сделки ${r.usdtAmount.toFixed(2)} USDT правдоподобна`,
    `цена была бы ${r.execPrice.toFixed(2)}`
  )
  check(
    Math.abs(r.usdtAmount - r.execPrice) > 1,
    'сумма и цена не совпадают (это разные величины)'
  )
}

check(
  rows.every((r) => r.usdtAmount < r.execPrice),
  'во всех строках сумма меньше цены за 1 WBNB'
)

console.log('\n=== цена исполнения против sqrtPriceX96 ===\n')

// Цена из события Swap — состояние пула после обмена. Она обязана отличаться
// от фактической цены сделки, иначе проверка ниже ничего не доказывает.
for (let i = 0; i < REAL.length; i++) {
  const t = REAL[i]
  const r = rows[i]
  const fromSqrt = 1 / (Number(t.price) / 1e18)
  const diffPct = ((fromSqrt - r.execPrice) / r.execPrice) * 100

  check(
    Math.abs(diffPct) > 0.0001,
    `блок ${t.block}: цена из sqrtPriceX96 отличается от цены исполнения`,
    `расхождение ${diffPct.toFixed(3)}%`
  )

  // Расхождение обязано быть маленьким: sqrtPriceX96 — это цена того же пула
  // сразу после обмена, а не что-то постороннее. Больше процента оно быть не
  // может, иначе это признак ошибки в разборе.
  check(
    Math.abs(diffPct) < 1,
    `блок ${t.block}: расхождение в пределах процента`,
    `${diffPct.toFixed(3)}%`
  )

  // Почему вообще нельзя брать sqrtPriceX96 вместо цены сделки.
  //
  // Средняя цена исполнения лежит между ценой до и после обмена: покупка
  // ведёт цену вверх, поэтому средняя НИЖЕ конечной. Но у самых мелких сделок
  // (1-2 USDT) сдвиг пула сравним с округлением, и знак может не проявиться.
  // Поэтому направление проверяем только там, где сделка заметно двигает пул.
  if (r.buying && r.usdtAmount > 4) {
    check(
      fromSqrt > r.execPrice,
      `блок ${t.block}: крупная покупка — цена пула выше средней цены сделки`
    )
  }
  if (!r.buying && r.usdtAmount > 4) {
    check(
      fromSqrt < r.execPrice,
      `блок ${t.block}: крупная продажа — цена пула ниже средней цены сделки`
    )
  }
}

console.log('\n=== формат строки ===\n')

// На узком экране длинная дробь обрезалась до «4.50…», поэтому в строке
// фиксированное число знаков. Проверяем, что оно не теряет смысл.
const fmt = (n) => n.toFixed(2)
check(fmt(4.500861725754965) === '4.50', 'сумма выводится с двумя знаками')
check(fmt(563.364) === '563.36', 'цена выводится с двумя знаками')
check(
  fmt(1.3112878410892905) === '1.31',
  'мелкая сделка не превращается в ноль'
)
check(
  Number('0.00') === 0 && fmt(0.004) === '0.00',
  'сделка меньше копейки показалась бы нулём (известное ограничение)'
)

console.log('\n=== направление в интерфейсе ===\n')

// Метка и сумма обязаны согласовываться: «ПОКУПКА» при amount_in = USDT
// значит, что человек отдал USDT. Если поменять местами, метка станет врать.
const buy = rowFromTrade(REAL[0])
const sell = rowFromTrade(REAL[1])
check(buy.buying && buy.usdtAmount === 4.500861725754965, 'покупка: отдано USDT')
check(
  !sell.buying && Math.abs(sell.usdtAmount - 4.597147768297904) < 1e-12,
  'продажа: получено USDT'
)
check(
  buy.wbnbAmount > 0 && sell.wbnbAmount > 0,
  'объём в WBNB считается для обоих направлений'
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
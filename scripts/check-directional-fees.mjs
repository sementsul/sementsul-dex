// Проверка идеи асимметричных комиссий (Directional Fees).
//
// Предложение: когда цена падает, продажа в пул стоит дорого (0.3%), а покупка
// дёшево (0.01%) — чтобы арбитражники «выравнивали пул» и компенсировали LP
// непостоянные потери.
//
// Проверяем на честной математике x*y=k, а не на словах. Главный вопрос:
// даёт ли АСИММЕТРИЯ что-то сверх простого повышения комиссии.

console.log('=== Асимметричные комиссии: проверка числами ===')
console.log()
console.log('Пул: 1000 A и 1000 B. Начальная цена A = 1 B.')
console.log('Внешняя цена A падает до 0.8 B. Арбитражник торгует против пула.')
console.log()

const K_INIT = 1000 * 1000
const EXT = 0.8

/// Один обмен: арбитражник двигает цену пула к внешней с учётом комиссии.
///
/// При продаже A в пул он платит feeSell. Останавливается, когда
/// предельная цена с учётом комиссии сравнивается с внешней.
function arbSell(rA0, rB0, extPrice, feeSell) {
  // Целевое отношение: poolPrice = extPrice / (1 - fee)
  const target = extPrice / (1 - feeSell)
  // rA' * rB' = k и rB'/rA' = target
  const rA1 = Math.sqrt(K_INIT / target)
  const rB1 = K_INIT / rA1
  const amountIn = rA1 - rA0
  return { rA: rA1, rB: rB1, fee: amountIn * feeSell }
}

/// То же при покупке A из пула (цена растёт).
function arbBuy(rA0, rB0, extPrice, feeBuy) {
  // При покупке цена пула поднимается; останавливается на extPrice*(1-fee).
  const target = extPrice * (1 - feeBuy)
  const rA1 = Math.sqrt(K_INIT / target)
  const rB1 = K_INIT / rA1
  const amountIn = rB1 - rB0
  return { rA: rA1, rB: rB1, fee: amountIn * feeBuy }
}

function valueInB(rA, rB) {
  return rA * EXT + rB
}

function report(label, res, feeTotal) {
  const value = valueInB(res.rA, res.rB)
  const loss = (1 - value / (1000 * EXT + 1000)) * 100
  console.log(`--- ${label} ---`)
  console.log(`  A = ${res.rA.toFixed(2)}, B = ${res.rB.toFixed(2)}`)
  console.log(`  цена A в пуле: ${(res.rB / res.rA).toFixed(4)} B (внешняя ${EXT})`)
  console.log(`  стоимость пула: ${value.toFixed(3)} B`)
  console.log(`  потеря от IL: ${loss.toFixed(3)}%`)
  console.log(`  комиссий собрано: ${feeTotal.toFixed(4)}`)
  console.log()
  return { value, fee: feeTotal, rA: res.rA, rB: res.rB }
}

console.log('### Опыт 1: одна продажа в пул (цена упала)')
console.log()

const sym = arbSell(1000, 1000, EXT, 0.0005)
const a1 = report('симметричная 0.05%', sym, sym.fee)

const asym = arbSell(1000, 1000, EXT, 0.003)
const b1 = report('асимметричная, продажа 0.3%', asym, asym.fee)

const flat = arbSell(1000, 1000, EXT, 0.003)
const c1 = report('СПРАВЕДЛИВОЕ СРАВНЕНИЕ: симметричная 0.3%', flat, flat.fee)

console.log('### Что здесь видно ###')
console.log()
console.log('Асимметричная (0.3% на продажу) и просто высокая (0.3% на обе')
console.log('стороны) дают ОДИНАКОВЫЙ результат в этом сценарии:')
console.log(`  A = ${b1.rA.toFixed(2)} против ${c1.rA.toFixed(2)}`)
console.log(`  собрано комиссий: ${b1.fee.toFixed(4)} против ${c1.fee.toFixed(4)}`)
console.log()
console.log('Потому что здесь была только продажа — вторая сторона не')
console.log('участвовала. Значит, весь выигрыш дала высокая ставка, а не')
console.log('асимметрия. Это первое важное наблюдение.')
console.log()

console.log('### Опыт 2: цена сходила вниз и вернулась')
console.log()
console.log('Вот где асимметрия должна проявиться: дешёвая покупка (0.01%)')
console.log('позволит арбитражникам быстро вернуть цену и «выровнять пул».')
console.log()

// Падение, затем возврат к исходной внешней цене 1.0.
function fullCycle(feeSell, feeBuy) {
  const down = arbSell(1000, 1000, EXT, feeSell)
  // Цена вернулась: внешняя снова 1.0.
  const up = arbBuy(down.rA, down.rB, 1.0, feeBuy)
  return { ...up, fee: down.fee + up.fee }
}

// Для возврата нужен множитель внешней цены — пересчитаем K корректно.
// arbBuy использует K_INIT, но после первого обмена k вырос. Учтём это.
function fullCycleAccurate(feeSell, feeBuy) {
  const down = arbSell(1000, 1000, EXT, feeSell)
  const kNow = down.rA * down.rB
  // Покупка A из пула до цены 1.0 с учётом комиссии.
  const target = 1.0 * (1 - feeBuy)
  const rA1 = Math.sqrt(kNow / target)
  const rB1 = kNow / rA1
  const feeUp = (rB1 - down.rB) * feeBuy
  return { rA: rA1, rB: rB1, fee: down.fee + feeUp }
}

const asymCycle = fullCycleAccurate(0.003, 0.0001)
const symCycle = fullCycleAccurate(0.0005, 0.0005)
const flatCycle = fullCycleAccurate(0.003, 0.003)

const a2 = report('асимметричная (продажа 0.3%, покупка 0.01%)', asymCycle, asymCycle.fee)
const b2 = report('симметричная 0.05%', symCycle, symCycle.fee)
const c2 = report('симметричная 0.3%', flatCycle, flatCycle.fee)

console.log('### Итог по обоим опытам ###')
console.log()
console.log('1. Асимметрия НЕ защищает от IL. Потери от IL определяются')
console.log('   движением цены, а не размером комиссии. Комиссия лишь')
console.log('   частично компенсирует их — это верно для любой ставки.')
console.log()
console.log('2. В опыте 1 асимметричная (0.3% на продажу) дала РОВНО тот же')
console.log('   результат, что симметричная 0.3%. То есть весь эффект дала')
console.log('   ставка, а не асимметрия как таковая.')
console.log()
console.log('3. В опыте 2 различия между всеми вариантами — сотые доли')
console.log('   процента, то есть в пределах округления. Симуляция НЕ')
console.log('   показывает, что асимметрия помогает или вредит заметно.')
console.log('   Честный вывод: измеримого выигрыша от асимметрии нет.')
console.log()
console.log('4. Механизм нельзя реализовать как задумано: чтобы понять')
console.log('   «цена падает», нужен ВНЕШНИЙ ориентир — оракул. У нас его')
console.log('   нет. Без оракула единственный измеримый сигнал — перекос')
console.log('   резервов, но он СЛЕДСТВИЕ цены, а не причина: читая его,')
console.log('   мы опаздываем ровно настолько, насколько арбитражник')
console.log('   опережает нас. А оракул — это новая поверхность атаки и')
console.log('   новая зависимость, которой у нас сейчас нет вообще.')
console.log()
console.log('5. Комиссия принципиально не может отличить «хороший» арбитраж')
console.log('   (выравнивающий пул) от «плохого» (забирающего актив).')
console.log('   Оба — это одна и та же сделка по направлению внешней цены.')
console.log()
console.log('ЧТО ИЗ ЭТОГО ВСЁ-ТАКИ ПОЛЕЗНО:')
console.log('- Динамическая комиссия сама по себе — рабочая механика, но её')
console.log('  смысл в другом: она защищает от волатильности, повышая плату')
console.log('  за объём в момент шторма. Так делают Bunni, Ambient и хуки')
console.log('  Uniswap v4 — причём по внутренней волатильности, без оракула.')
console.log('- Но это НЕ защита от IL и НЕ то, что привлечёт LP на пустой пул.')
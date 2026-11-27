// Создание пулов в наших фабриках (V2 и V3).
//
// Зачем отдельный модуль. Создание пула — это один вызов фабрики, но
// требует аккуратности в двух местах:
//
//   1. V2 createPair(tokenA, tokenB) разворачивает адреса сам, но при
//      повторном вызове на существующую пару просто вернёт её адрес.
//      Лишний газ платить не нужно, поэтому существование проверяем
//      заранее через getPair.
//
//   2. V3 createPool(tokenA, tokenB, fee) требует, чтобы fee был включён
//      в tickSpacing фабрики. Наш набор: 50/500/2500/10000 с шагами
//      1/10/50/200. Pancake-тир 100 (0.01%) наша фабрика не поддерживает,
//      и попытка создать такой пул откатится.
//
// Пустой пул не торгуется: после создания в него надо внести ликвидность.
// Интерфейс об этом предупреждает, но и здесь это отражено.
import { SEL, encAddr, encUint } from './abi.js'
import { V2_FACTORY, V3_FACTORY, V3_FEE_TIERS, tokenByAddress } from './config.js'
import { toPoolToken } from './pools.js'

// Шаги тика для наших тиров. Должны совпадать с тем, что выставлено
// в фабрике: если разойдутся, createPool откатится с «InvalidFee».
export const TICK_SPACING = {
  50: 1,
  500: 10,
  2500: 50,
  10000: 200,
}

export function tierLabel(fee) {
  // Единица комиссии — 1e-6, то есть fee=500 это 0.05%, а fee=50 это
  // 0.005%. Округлять до двух знаков нельзя: 0.005% превратилось бы в
  // «0.01%», а это у Pancake отдельный тир со своей цифрой 100. Люди
  // путают эти два, поэтому показываем точное значение.
  //
  // Деление на 10000 даёт точные значения для всех наших тиров без
  // плавающих артефактов: 50 -> 0.005, 100 -> 0.01, 500 -> 0.05,
  // 2500 -> 0.25, 10000 -> 1. Поэтому хватает String(), и «1.00%»
  // не появляется.
  return String(fee / 10000) + '%'
}

export function buildCreatePair(tokenA, tokenB) {
  const a = toPoolToken(tokenA)
  const b = toPoolToken(tokenB)
  if (a.toLowerCase() === b.toLowerCase()) {
    return { error: 'SAME_TOKEN', message: 'Это один и тот же токен' }
  }
  return {
    to: V2_FACTORY,
    data: SEL.createPair + encAddr(a) + encAddr(b),
    value: 0n,
    label: 'Создать пул V2',
  }
}

export function buildCreatePool(tokenA, tokenB, fee) {
  const a = toPoolToken(tokenA)
  const b = toPoolToken(tokenB)
  if (a.toLowerCase() === b.toLowerCase()) {
    return { error: 'SAME_TOKEN', message: 'Это один и тот же токен' }
  }
  if (!V3_FEE_TIERS.includes(fee)) {
    return {
      error: 'BAD_FEE',
      message: 'Тир ' + fee + ' наша фабрика не поддерживает. Доступны: ' + V3_FEE_TIERS.map(tierLabel).join(', '),
    }
  }
  return {
    to: V3_FACTORY,
    data: SEL.createPool + encAddr(a) + encAddr(b) + encUint(BigInt(fee)),
    value: 0n,
    label: 'Создать пул V3 ' + tierLabel(fee),
  }
}

// Проверка тира до отправки: шаг тика должен совпадать с ожидаемым.
export function validateTier(fee) {
  if (!V3_FEE_TIERS.includes(fee)) {
    return { ok: false, message: 'Недопустимый тир для нашей фабрики' }
  }
  if (!TICK_SPACING[fee]) {
    return { ok: false, message: 'Нет шага тика для тира ' + fee }
  }
  return { ok: true }
}

// Подсказка: у Pancake есть тир 0.01%, у нас нет. Люди привыкли к нему,
// поэтому честно говорим, а не молча роняем транзакцию.
export function unsupportedPancakeTiers() {
  return [100]
}
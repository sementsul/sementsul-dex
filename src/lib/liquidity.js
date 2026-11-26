// Пулы: перечисление, TVL, создание, добавление и вывод ликвидности.
//
// Главный принцип: пул создаёт кто угодно, разрешения не спрашиваем — так же,
// как в Pancake. Но интерфейс обязан показать, что создаётся, до подписи:
// пул с нулевой ликвидностью бесполезен, а пул с неправильной ценой опасен
// для того, кто добавит туда деньги вторым.

import {
  V2_FACTORY,
  V2_ROUTER,
  V3_FACTORY,
  WBNB,
  USDT,
  KNOWN_TOKENS,
  KNOWN_POOLS,
  HAS_OWN_DEX,
  HAS_OWN_V3,
  PANCAKE_V2_FACTORY,
} from './chain.js'
import { keccak256 } from 'viem'
import { SEL, encAddress, encUint, decAddress, decUint, decInt, words } from './abi.js'
import { batchCall, call } from './rpc.js'
import { readTokenMeta } from './pools.js'

const ZERO = '0x0000000000000000000000000000000000000000'

// ---------------------------------------------------------------------------
// Список пулов
// ---------------------------------------------------------------------------

// Перечислить V2-пары.
//
// Есть важная асимметрия между своей фабрикой и Pancake, и её нельзя
// игнорировать:
//
//   • Своя фабрика знает свои пары точно (allPairsSlice). Их десятки, и все
//     они наши — перечисляем полностью.
//   • У Pancake 3,77 млн пар, и allPairsSlice у него нет. Перебрать их по
//     одной — это миллионы запросов, то есть не вариант. Поэтому для Pancake
//     показываем только известные пары из KNOWN_POOLS и пары популярных
//     токенов с WBNB.
//
// Иначе экран «Пулы» на Pancake либо падал бы с ошибкой метода, либо висел
// бы минутами, что для пользователя одно и то же.
export async function listV2Pairs({ pageSize = 50, max = 300 } = {}) {
  if (!HAS_OWN_DEX) {
    return listPancakeKnownPairs()
  }

  const lenHex = await call(V2_FACTORY, SEL.allPairsLength)
  const total = Number(decUint(lenHex, 0))
  if (!total) return []

  const count = Math.min(total, max)
  const out = []
  for (let start = 0; start < count; start += pageSize) {
    const end = Math.min(start + pageSize, count)
    const hex = await call(V2_FACTORY, SEL.allPairsSlice + encUint(start) + encUint(end))
    for (const w of words(hex)) {
      const addr = '0x' + w.slice(24)
      if (addr !== ZERO) out.push(addr)
    }
  }
  return out
}

// Пулы Pancake, о которых стоит знать: пары из KNOWN_POOLS плюс пары
// популярных токенов с WBNB. Список конечный и проверенный, поэтому
// укладывается в десяток вызовов getPair.
async function listPancakeKnownPairs() {
  const found = new Set()

  // Явно перечисленные пулы.
  for (const p of KNOWN_POOLS) {
    if (p.protocol === 'v2' && p.address) found.add(p.address)
  }

  // Пары популярных токенов с WBNB: именно они нужны для TVL и для того,
  // чтобы человек увидел знакомые названия, а не пустой экран.
  const calls = []
  for (const t of KNOWN_TOKENS) {
    if (!t.address || t.native || t.address.toLowerCase() === WBNB.toLowerCase()) continue
    calls.push({
      to: PANCAKE_V2_FACTORY,
      data: SEL.getPair + encAddress(t.address) + encAddress(WBNB),
    })
  }

  if (calls.length) {
    const res = await batchCall(calls)
    for (const hex of res) {
      const a = decAddress(hex)
      if (a && a !== ZERO) found.add(a)
    }
  }

  return [...found]
}

// Перечислить V3-пулы: у фабрики есть allPools(uint256) и allPoolsLength().
export async function listV3Pools({ max = 200 } = {}) {
  if (!HAS_OWN_V3) return []
  const lenHex = await call(V3_FACTORY, SEL.allPoolsLength)
  const total = Math.min(Number(decUint(lenHex, 0)), max)
  if (!total) return []

  const calls = []
  for (let i = 0; i < total; i++) {
    calls.push({ to: V3_FACTORY, data: SEL.allPools + encUint(i) })
  }
  const res = await batchCall(calls)
  return res.map((h) => decAddress(h)).filter((a) => a && a !== ZERO)
}

// ---------------------------------------------------------------------------
// TVL
// ---------------------------------------------------------------------------

// Сколько стоит пул в долларах.
//
// Честно посчитать TVL можно только через цену в стейблкоине. Полноценный
// оракул — отдельная инфраструктура, поэтому схема простая и явная: если в
// пуле есть USDT, цена берётся из него; иначе идём в пул токена с USDT.
//
// Возврат null означает «не знаю», и интерфейс обязан показать прочерк.
// Ноль здесь был бы ложью: пользователь решил бы, что пул пустой.
export async function pairTvlDollars(token0, token1, reserve0, reserve1, decimals0, decimals1) {
  const t0 = token0.toLowerCase()
  const t1 = token1.toLowerCase()
  const usdt = USDT.toLowerCase()

  const human0 = Number(reserve0) / 10 ** decimals0
  const human1 = Number(reserve1) / 10 ** decimals1

  // В пуле есть USDT — считаем по нему напрямую, это самый точный случай.
  if (t0 === usdt) return human0 * 2
  if (t1 === usdt) return human1 * 2

  // Иначе оцениваем один из токенов через его пул с USDT.
  for (const [tok, amt] of [
    [token0, human0],
    [token1, human1],
  ]) {
    const price = await priceInUsdt(tok)
    if (price !== null) return amt * price * 2
  }
  return null
}

// Цена токена в USDT по пулу с USDT на нашей фабрике. Кешируем: экран пулов
// читает десятки пулов, и без кеша это десятки одинаковых запросов.
const priceCache = new Map()
export async function priceInUsdt(token) {
  const key = token.toLowerCase()
  if (key === USDT.toLowerCase()) return 1
  if (priceCache.has(key)) return priceCache.get(key)

  const hex = await call(V2_FACTORY, SEL.getPair + encAddress(token) + encAddress(USDT))
  const pair = decAddress(hex)
  if (!pair || pair === ZERO) {
    priceCache.set(key, null)
    return null
  }

  const [resHex, t0Hex, decHex] = await batchCall([
    { to: pair, data: SEL.getReserves },
    { to: pair, data: SEL.token0 },
    { to: token, data: SEL.decimals },
  ])
  const r = words(resHex)
  if (r.length < 2) {
    priceCache.set(key, null)
    return null
  }
  const tokenIsT0 = decAddress(t0Hex).toLowerCase() === key
  const resToken = BigInt('0x' + (tokenIsT0 ? r[0] : r[1]))
  const resUsdt = BigInt('0x' + (tokenIsT0 ? r[1] : r[0]))
  if (resToken === 0n) {
    priceCache.set(key, null)
    return null
  }
  const dec = Number(decUint(decHex, 0))
  const price = Number(resUsdt) / 1e18 / (Number(resToken) / 10 ** dec)
  priceCache.set(key, price)
  return price
}

export function clearPriceCache() {
  priceCache.clear()
}

// ---------------------------------------------------------------------------
// Описание пулов
// ---------------------------------------------------------------------------

export async function describeV2Pair(address) {
  const [resHex, t0Hex, t1Hex, supplyHex, feeHex] = await batchCall([
    { to: address, data: SEL.getReserves },
    { to: address, data: SEL.token0 },
    { to: address, data: SEL.token1 },
    { to: address, data: SEL.totalSupply },
    { to: address, data: SEL.fee },
  ])
  if (!resHex || resHex === '0x') return null

  const r = words(resHex)
  if (r.length < 2) return null

  const token0 = decAddress(t0Hex)
  const token1 = decAddress(t1Hex)
  if (!token0 || !token1) return null

  const reserve0 = BigInt('0x' + r[0])
  const reserve1 = BigInt('0x' + r[1])
  const supply = decUint(supplyHex, 0)

  const [meta0, meta1] = await Promise.all([readTokenMeta(token0), readTokenMeta(token1)])
  if (!meta0 || !meta1) return null

  const tvl = await pairTvlDollars(token0, token1, reserve0, reserve1, meta0.decimals, meta1.decimals)

  // Комиссия у нашей пары читается из fee() в единицах 1e-6. У Pancake такого
    // метода нет (там ставка зашита в контракт), поэтому для чужих пар остаётся
    // null — интерфейс покажет прочерк, а не выдуманное число.
    const fee = feeHex && feeHex !== '0x' ? Number(decUint(feeHex, 0)) : null

  return {
    address,
    protocol: 'v2',
    token0: { ...meta0, address: token0 },
    token1: { ...meta1, address: token1 },
    reserve0,
    reserve1,
    totalSupply: supply,
    tvl,
    fee,
  }
}

export async function describeV3Pool(address) {
  const [slot0Hex, liqHex, feeHex, t0Hex, t1Hex, spacingHex] = await batchCall([
    { to: address, data: SEL.slot0 },
    { to: address, data: SEL.liquidity },
    { to: address, data: SEL.fee },
    { to: address, data: SEL.token0 },
    { to: address, data: SEL.token1 },
    { to: address, data: SEL.tickSpacing },
  ])
  if (!slot0Hex || slot0Hex === '0x') return null

  const token0 = decAddress(t0Hex)
  const token1 = decAddress(t1Hex)
  if (!token0 || !token1) return null

  const [meta0, meta1] = await Promise.all([readTokenMeta(token0), readTokenMeta(token1)])
  if (!meta0 || !meta1) return null

  const sqrtPriceX96 = decUint(slot0Hex, 0)
  const fee = Number(decUint(feeHex, 0))

  // Цена из sqrtPriceX96: (sqrtP / 2^96)^2, с поправкой на decimals.
  // Без поправки цена токена с 6 знаками отличалась бы в 10^12 раз.
  let price = null
  if (sqrtPriceX96 > 0n) {
    const raw = (Number(sqrtPriceX96) / 2 ** 96) ** 2
    price = raw * 10 ** (meta0.decimals - meta1.decimals)
  }

  // В V3 liquidity — не сумма токенов, а множитель в формуле. TVL считаем по
  // фактическим балансам контракта: в них лежит всё, что не забрано.
  const [bal0Hex, bal1Hex] = await batchCall([
    { to: token0, data: SEL.balanceOf + encAddress(address) },
    { to: token1, data: SEL.balanceOf + encAddress(address) },
  ])
  const bal0 = decUint(bal0Hex, 0)
  const bal1 = decUint(bal1Hex, 0)
  const tvl = await pairTvlDollars(token0, token1, bal0, bal1, meta0.decimals, meta1.decimals)

  return {
    address,
    protocol: 'v3',
    token0: { ...meta0, address: token0 },
    token1: { ...meta1, address: token1 },
    fee,
    tickSpacing: Number(decUint(spacingHex, 0)),
    sqrtPriceX96,
    // tick — это int24, а не uint. Читать его беззнаково нельзя: при
    // отрицательном тике (цена ниже 1) decUint вернёт число около 2^256, и
    // диапазоны вокруг него уедут в бесконечность.
    tick: Number(decInt(slot0Hex, 1)),
    liquidity: decUint(liqHex, 0),
    balance0: bal0,
    balance1: bal1,
    price,
    tvl,
  }
}

// Собрать список пулов для экрана.
//
// Пустые пулы не выбрасываем: пользователь мог только что создать пул и должен
// увидеть его в списке, иначе решит, что создание не сработало.
export async function loadPools() {
  const [v2addrs, v3addrs] = await Promise.all([listV2Pairs(), listV3Pools()])

  const v2 = await Promise.all(v2addrs.map((a) => describeV2Pair(a).catch(() => null)))
  const v3 = await Promise.all(v3addrs.map((a) => describeV3Pool(a).catch(() => null)))

  const all = [...v2.filter(Boolean), ...v3.filter(Boolean)]

  return all.sort((a, b) => {
    const ta = a.tvl ?? -1
    const tb = b.tvl ?? -1
    if (tb !== ta) return tb - ta
    return (a.token0.symbol + a.token1.symbol).localeCompare(b.token0.symbol + b.token1.symbol)
  })
}

export function isEmptyPool(p) {
  return p.protocol === 'v2' ? p.reserve0 === 0n && p.reserve1 === 0n : p.balance0 === 0n && p.balance1 === 0n
}

// ---------------------------------------------------------------------------
// Создание пула
// ---------------------------------------------------------------------------

export function buildCreatePair(tokenA, tokenB) {
  return {
    to: V2_FACTORY,
    data: SEL.createPair + encAddress(tokenA) + encAddress(tokenB),
    value: 0n,
    kind: 'create-pair',
  }
}

// Создание пула V3 требует тира: одна фабрика держит по пулу на каждый тир,
// и без комиссии непонятно, какой именно создавать.
export function buildCreatePool(tokenA, tokenB, fee) {
  if (!Number.isInteger(fee) || fee <= 0) {
    throw new Error('для создания пула V3 нужен тир комиссии')
  }
  return {
    to: V3_FACTORY,
    data: SEL.createPool + encAddress(tokenA) + encAddress(tokenB) + encUint(fee),
    value: 0n,
    kind: 'create-pool',
  }
}

// ---------------------------------------------------------------------------
// Ликвидность V2
// ---------------------------------------------------------------------------

export function buildAddLiquidityV2({
  tokenA,
  tokenB,
  amountADesired,
  amountBDesired,
  slippageBps = 50,
  to,
  deadlineSec = 1200,
}) {
  const amountAMin = (amountADesired * BigInt(10000 - slippageBps)) / 10000n
  const amountBMin = (amountBDesired * BigInt(10000 - slippageBps)) / 10000n
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec)

  return {
    to: V2_ROUTER,
    data:
      SEL.addLiquidity +
      encAddress(tokenA) +
      encAddress(tokenB) +
      encUint(amountADesired) +
      encUint(amountBDesired) +
      encUint(amountAMin) +
      encUint(amountBMin) +
      encAddress(to) +
      encUint(deadline),
    value: 0n,
    kind: 'add-liquidity-v2',
  }
}

// removeLiquidity: сжигает LP-токены и возвращает оба токена.
//
// minAmountA/minAmountB оставлены нулями осознанно: точный расчёт минимумов
// требует знать резервы в момент подписи, а между подписью и исполнением они
// меняются. Ноль означает «согласен на любую цену» — это приемлемо только
// потому, что LP-токен возвращает пропорционально, и вывести больше, чем
// вложил, невозможно. Для вывода ликвидности проскальзывание не работает как
// в свопе: тут нет обмена одной монеты на другую по цене.
export function buildRemoveLiquidityV2({ tokenA, tokenB, liquidity, to, deadlineSec = 1200 }) {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec)

  return {
    to: V2_ROUTER,
    data:
      SEL.removeLiquidity +
      encAddress(tokenA) +
      encAddress(tokenB) +
      encUint(liquidity) +
      encUint(0n) +
      encUint(0n) +
      encAddress(to) +
      encUint(deadline),
    value: 0n,
    kind: 'remove-liquidity-v2',
  }
}

// LP-токены, принадлежащие адресу: только у пары, читается как обычный ERC-20.
export async function readLpBalance(pairAddress, owner) {
  const hex = await call(pairAddress, SEL.balanceOf + encAddress(owner))
  return decUint(hex, 0)
}

export async function readLpSupply(pairAddress) {
  const hex = await call(pairAddress, SEL.totalSupply)
  return decUint(hex, 0)
}

// ---------------------------------------------------------------------------
// Ликвидность V3
// ---------------------------------------------------------------------------

// mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount)
//
// Тики кодируются как int256 в дополнительном коде — encUint это уже умеет:
// для отрицательного числа он выдаёт (x + 2^256), что и есть нужные 32 байта.
export function buildMintV3({ pool, recipient, tickLower, tickUpper, liquidity }) {
  return {
    to: pool,
    data:
      SEL.mintV3 +
      encAddress(recipient) +
      encUint(tickLower) +
      encUint(tickUpper) +
      encUint(liquidity),
    value: 0n,
    kind: 'mint-v3',
  }
}

// burn(int24,int24,uint128) — снять ликвидность, комиссии остаются в позиции.
export function buildBurnV3({ pool, tickLower, tickUpper, liquidity }) {
  return {
    to: pool,
    data: SEL.burnV3 + encUint(tickLower) + encUint(tickUpper) + encUint(liquidity),
    value: 0n,
    kind: 'burn-v3',
  }
}

// collect(address,int24,int24,uint128,uint128) — забрать начисленные комиссии
// и токены, оставшиеся после burn. Максимумы ограничены uint128, поэтому
// передаём 2^128-1, а не 2^256-1: Solidity откажет по декодеру ABI, ещё до
// входа в функцию, и причина будет выглядеть загадочно.
const MAX_UINT128 = (1n << 128n) - 1n

export function buildCollectV3({ pool, recipient, tickLower, tickUpper, amount0Max, amount1Max }) {
  return {
    to: pool,
    data:
      SEL.collect +
      encAddress(recipient) +
      encUint(tickLower) +
      encUint(tickUpper) +
      encUint(amount0Max ?? MAX_UINT128) +
      encUint(amount1Max ?? MAX_UINT128),
    value: 0n,
    kind: 'collect-v3',
  }
}

// Позиция в V3: ключ = keccak256(abi.encodePacked(owner, int24 tickLower, int24 tickUpper)).
//
// Тики упакованы как int24 — ровно 3 байта каждый, не 4 и не 32. Если взять
// лишний байт, хеш не совпадёт ни с одной реальной позицией, чтение вернёт
// нули, и это будет выглядеть как «позиции нет», хотя она есть.
//
// Ключ захеширован, а не передан как есть: positions — это mapping(bytes32 => ...),
// и контракт кладёт туда именно keccak256. Отправить сам packed-набор —
// классическая ошибка, которая молча даёт пустой ответ.
export function v3PositionKey(owner, tickLower, tickUpper) {
  const addr = owner.toLowerCase().replace(/^0x/, '')
  const packed = addr + int24Hex(tickLower) + int24Hex(tickUpper)
  return keccak256('0x' + packed)
}

// int24 в трёхбайтовом дополнительном коде.
export function int24Hex(v) {
  let n = BigInt(v)
  if (n < 0n) n += 1n << 24n
  return n.toString(16).padStart(6, '0')
}

// Прочитать позицию V3. Возвращает null, если позиции нет.
//
// Геттер структуры отдаёт поля по порядку объявления: liquidity,
// feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0,
// tokensOwed1, pending0, pending1, vestBlock. Если переставить поля в
// контракте, эти индексы поедут молча — поэтому порядок менять нельзя без
// правки здесь.
export async function readV3Position(pool, owner, tickLower, tickUpper) {
  const key = v3PositionKey(owner, tickLower, tickUpper).replace(/^0x/, '')
  const hex = await call(pool, SEL.positions + key)
  if (!hex || hex === '0x') return null

  const liquidity = decUint(hex, 0)
  const owed0 = decUint(hex, 3)
  const owed1 = decUint(hex, 4)
  const pending0 = decUint(hex, 5)
  const pending1 = decUint(hex, 6)
  const vestBlock = decUint(hex, 7)
  if (liquidity === 0n && owed0 === 0n && owed1 === 0n && pending0 === 0n && pending1 === 0n) return null

  return {
    liquidity,
    feeGrowthInside0LastX128: decUint(hex, 1),
    feeGrowthInside1LastX128: decUint(hex, 2),
    tokensOwed0: owed0,
    tokensOwed1: owed1,
    // Комиссия, которая ещё «отлеживается»: забрать её можно только после
    // блока vestBlock, и только если ликвидность к тому моменту не снята.
    pending0,
    pending1,
    vestBlock,
  }
}
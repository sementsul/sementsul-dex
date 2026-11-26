// Ядро котирования. Вся математика считается в браузере — RPC нужен только для
// чтения состояния пулов. Это ровно то, что даёт MEV Guard с батчем на 100 вызовов:
// один HTTP-запрос забирает резервы всех пулов.

import { batchCall, call } from './rpc.js'
import { SEL, encAddress, encUint, decUint, decAddress, decInt, decString, words } from './abi.js'
import { V2_FACTORY, V3_FACTORY, V3_FEE_TIERS, WBNB, USDT, V2_FEE, V2_FEE_DENOMINATOR, HAS_OWN_V3, DEPLOYMENT_INFO } from './chain.js'

// ---------- V2 ----------

// getAmountOut по формуле x*y=k с комиссией пула.
//
// Ставка приходит из деплоя, а не зашита: у Pancake это 9975/10000 (0.25%),
// у своей биржи — произвольная, в единицах 1e-6. Поэтому вместо литерала
// считаем (1e6 - fee)/1e6, что верно для обоих случаев.
export function getAmountOutV2(amountIn, reserveIn, reserveOut, fee = V2_FEE, denom = V2_FEE_DENOMINATOR) {
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const amountInWithFee = amountIn * (denom - fee)
  const numerator = amountInWithFee * reserveOut
  const denominator = reserveIn * denom + amountInWithFee
  return numerator / denominator
}

// Обратный расчёт: сколько нужно на входе, чтобы получить amountOut.
export function getAmountInV2(amountOut, reserveIn, reserveOut, fee = V2_FEE, denom = V2_FEE_DENOMINATOR) {
  if (amountOut <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n
  const numerator = reserveIn * amountOut * denom
  const denominator = (reserveOut - amountOut) * (denom - fee)
  return numerator / denominator + 1n
}

// ---------- V3 (качественная оценка по slot0) ----------

// sqrtPriceX96 -> цена token1/token0 в сырых единицах (не человекочитаемых).
export function sqrtX96ToPrice(sqrtPriceX96) {
  const Q96 = 1n << 96n
  // цена = (sqrtP / Q96)^2 — считаем с масштабированием, чтобы не потерять точность
  const p = (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / (Q96 * Q96)
  return p
}

// Грубая оценка выхода для V3 без прохода по тикам. Годится только для сравнения
// пулов между собой; точный расчёт делает QuoterV2.
export function estimateV3(amountIn, sqrtPriceX96, feePpm, zeroForOne) {
  if (amountIn <= 0n || sqrtPriceX96 <= 0n) return 0n
  const Q96 = 1n << 96n
  const after = amountIn - (amountIn * BigInt(feePpm)) / 1_000_000n
  // Приближение: считаем как x*y=k в окрестности текущей цены.
  const price = (sqrtPriceX96 * sqrtPriceX96) / Q96 // token1 за token0, *Q96
  if (zeroForOne) {
    return (after * price) / Q96
  }
  return (after * Q96) / price
}

// ---------- Чтение пулов ----------

// Резервы V2-пары.
export async function readV2Pair(pairAddress) {
  const [reservesHex, token0Hex, token1Hex] = await batchCall([
    { to: pairAddress, data: SEL.getReserves },
    { to: pairAddress, data: SEL.token0 },
    { to: pairAddress, data: SEL.token1 },
  ])
  if (!reservesHex) return null
  const w = words(reservesHex)
  return {
    address: pairAddress,
    reserve0: BigInt('0x' + w[0]),
    reserve1: BigInt('0x' + w[1]),
    token0: decAddress(token0Hex),
    token1: decAddress(token1Hex),
  }
}

// Состояние V3-пула: slot0 + liquidity.
export async function readV3Pool(poolAddress) {
  const [slot0Hex, liqHex] = await batchCall([
    { to: poolAddress, data: SEL.slot0 },
    { to: poolAddress, data: SEL.liquidity },
  ])
  if (!slot0Hex) return null
  return {
    address: poolAddress,
    sqrtPriceX96: decUint(slot0Hex, 0),
    tick: Number(decInt(slot0Hex, 1)),
    liquidity: decUint(liqHex, 0),
  }
}

// Найти V2-пару через фабрику.
//
// getPair есть и у Pancake, и у нас, поэтому годится как единый путь. Но своя
// фабрика умеет pairFor — детерминированный расчёт адреса без чтения
// хранилища; если он доступен, пользуемся им как быстрым путём, а getPair
// остаётся проверкой, что пара действительно создана.
export async function findV2Pair(tokenA, tokenB) {
  const hex = await call(V2_FACTORY, SEL.getPair + encAddress(tokenA) + encAddress(tokenB))
  const addr = decAddress(hex)
  if (!addr || addr === '0x0000000000000000000000000000000000000000') return null
  return addr
}

// Найти V3-пул через фабрику по тиру.
//
// Теперь и своя фабрика, и Pancake отвечают на getPool(token0,token1,fee):
// переделка на четыре тира убрала единственное расхождение в API. Различия
// в адресах фабрик остаются, различий в способе вызова — больше нет.
export async function findV3Pool(tokenA, tokenB, fee) {
  const hex = await call(
    V3_FACTORY,
    SEL.getPool + encAddress(tokenA) + encAddress(tokenB) + encUint(fee)
  )
  const addr = decAddress(hex)
  if (!addr || addr === '0x0000000000000000000000000000000000000000') return null
  return addr
}

// Все V3-пулы для пары по всем включённым тирам — одним батчем.
export async function findAllV3Pools(tokenA, tokenB) {
  const tiers = HAS_OWN_V3 ? ownedTiers() : V3_FEE_TIERS
  const calls = tiers.map((fee) => ({
    to: V3_FACTORY,
    data: SEL.getPool + encAddress(tokenA) + encAddress(tokenB) + encUint(fee),
  }))
  const results = await batchCall(calls)
  const pools = []
  results.forEach((hex, i) => {
    const addr = decAddress(hex)
    if (addr && addr !== '0x0000000000000000000000000000000000000000') {
      pools.push({ address: addr, fee: tiers[i] })
    }
  })
  return pools
}

// Тиры, которые реально включены на нашей фабрике.
//
// Список тиров — параметр конструктора, а не константа в коде, поэтому
// спрашиваем фабрику, а не берём V3_FEE_TIERS. Иначе после смены набора
// интерфейс продолжил бы искать пулы по старым ставкам и молча показывал бы
// «пулов нет».
export function ownedTiers() {
  return DEPLOYMENT_INFO?.v3FeeTiers ?? [DEPLOYMENT_INFO?.v3Fee ?? 500]
}

// Метаданные токена: symbol, name, decimals — одним батчем.
// Возвращает null, если по адресу нет ERC-20: пустой ответ eth_call иначе
// превращается в «Cannot convert 0x to a BigInt» глубоко в форматтере.
export async function readTokenMeta(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return null

  const [symHex, nameHex, decHex, supplyHex] = await batchCall([
    { to: address, data: SEL.symbol },
    { to: address, data: SEL.name },
    { to: address, data: SEL.decimals },
    { to: address, data: SEL.totalSupply },
  ])

  // decimals — единственное обязательное поле ERC-20; без него токен бесполезен.
  if (!decHex || decHex === '0x') return null
  const decimals = Number(BigInt(decHex))
  if (!Number.isFinite(decimals) || decimals > 36) return null

  let symbol = ''
  try {
    symbol = decString(symHex)
  } catch {
    symbol = ''
  }
  if (!symbol) {
    // некоторые токены отдают bytes32 вместо string
    const w = words(symHex)
    if (w[0]) {
      const bytes = w[0].match(/.{1,2}/g) ?? []
      const arr = new Uint8Array(bytes.map((b) => parseInt(b, 16)))
      symbol = new TextDecoder().decode(arr).replace(/\0/g, '')
    }
  }

  let name = ''
  try {
    name = decString(nameHex)
  } catch {
    name = ''
  }

  return {
    address,
    symbol: symbol || '???',
    name: name || symbol || 'Unknown',
    decimals,
    totalSupply: supplyHex ? decUint(supplyHex, 0) : 0n,
  }
}

export async function readBalanceOf(token, owner) {
  const hex = await call(token, SEL.balanceOf + encAddress(owner))
  return hex ? decUint(hex, 0) : 0n
}

export async function readAllowance(token, owner, spender) {
  const hex = await call(token, SEL.allowance + encAddress(owner) + encAddress(spender))
  return hex ? decUint(hex, 0) : 0n
}

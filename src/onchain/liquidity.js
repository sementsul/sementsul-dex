// Ликвидность: V2 через роутер, V3 через пул напрямую.
//
// Почему V3 иначе. У нашего V3 нет позиционного менеджера: позиция — это
// запись в хранилище пула, привязанная к адресу владельца, а не NFT.
// Значит addLiquidity/removeLiquidity роутера для нас не работают, и
// вызывать надо сам пул: mint(recipient, tickLower, tickUpper, amount).
// Забирать — burn(...) плюс collect(...) для накопленных комиссий.

import { SEL, encAddr, encUint, decUint, decAddress, decInt, positionKey } from './abi.js'
import { V2_ROUTER, V3_ROUTER, PANCAKE_V2_ROUTER, WBNB, NATIVE } from './config.js'
import { toPoolToken, isNative } from './pools.js'

// ---------- V2 ----------
export function buildAddLiquidityV2({ tokenA, tokenB, amountA, amountB, minA, minB, recipient, deadline, own }) {
  const router = own ? V2_ROUTER : PANCAKE_V2_ROUTER
  const a = toPoolToken(tokenA)
  const b = toPoolToken(tokenB)

  if (isNative(tokenA) || isNative(tokenB)) {
    const token = isNative(tokenA) ? b : a
    const amountToken = isNative(tokenA) ? amountB : amountA
    const amountBNB = isNative(tokenA) ? amountA : amountB
    const minToken = isNative(tokenA) ? minB : minA
    const minBNB = isNative(tokenA) ? minA : minB
    return {
      to: router,
      data:
        SEL.addLiquidityETH +
        encAddr(token) +
        encUint(amountToken) +
        encUint(minToken) +
        encUint(minBNB) +
        encAddr(recipient) +
        encUint(deadline),
      value: amountBNB,
      needsApprove: token,
    }
  }

  return {
    to: router,
    data:
      SEL.addLiquidity +
      encAddr(a) +
      encAddr(b) +
      encUint(amountA) +
      encUint(amountB) +
      encUint(minA) +
      encUint(minB) +
      encAddr(recipient) +
      encUint(deadline),
    value: 0n,
    needsApprove: [a, b],
  }
}

export function buildRemoveLiquidityV2({ tokenA, tokenB, liquidity, minA, minB, recipient, deadline, own }) {
  const router = own ? V2_ROUTER : PANCAKE_V2_ROUTER
  const a = toPoolToken(tokenA)
  const b = toPoolToken(tokenB)

  if (isNative(tokenA) || isNative(tokenB)) {
    const token = isNative(tokenA) ? b : a
    const minToken = isNative(tokenA) ? minB : minA
    const minBNB = isNative(tokenA) ? minA : minB
    return {
      to: router,
      data:
        SEL.removeLiquidityETH +
        encAddr(token) +
        encUint(liquidity) +
        encUint(minToken) +
        encUint(minBNB) +
        encAddr(recipient) +
        encUint(deadline),
      value: 0n,
    }
  }
  return {
    to: router,
    data:
      SEL.removeLiquidity +
      encAddr(a) +
      encAddr(b) +
      encUint(liquidity) +
      encUint(minA) +
      encUint(minB) +
      encAddr(recipient) +
      encUint(deadline),
    value: 0n,
  }
}

// ---------- V3 ----------
// Наш пул: mint(recipient, tickLower, tickUpper, amount)
export function buildMintV3({ pool, recipient, tickLower, tickUpper, liquidity }) {
  return {
    to: pool,
    data: SEL.mint + encAddr(recipient) + encUint(tickLower) + encUint(tickUpper) + encUint(liquidity),
    value: 0n,
  }
}

// burn(int24,int24,uint128) — уменьшает позицию и начисляет к сбору
export function buildBurnV3({ pool, tickLower, tickUpper, liquidity }) {
  return {
    to: pool,
    data: SEL.burn + encUint(tickLower) + encUint(tickUpper) + encUint(liquidity),
    value: 0n,
  }
}

// collect(recipient, tickLower, tickUpper, amount0Max, amount1Max)
export function buildCollectV3({ pool, recipient, tickLower, tickUpper, amount0Max, amount1Max }) {
  const MAX = (1n << 128n) - 1n
  return {
    to: pool,
    data:
      SEL.collect +
      encAddr(recipient) +
      encUint(tickLower) +
      encUint(tickUpper) +
      encUint(amount0Max ?? MAX) +
      encUint(amount1Max ?? MAX),
    value: 0n,
  }
}

// Читает позицию: liquidity + сколько токенов накопилось к сбору.
// Наш positions() возвращает 8 полей (см. contracts/SementsulV3.sol).
export async function readPosition(pool, owner, tickLower, tickUpper, callMany) {
  const key = positionKey(owner, tickLower, tickUpper)
  const [res] = await callMany([{ to: pool, data: SEL.positions + key.slice(2) }])
  if (!res) return null
  return {
    liquidity: decUint(res, 0),
    feeGrowthInside0: decUint(res, 1),
    feeGrowthInside1: decUint(res, 2),
    tokensOwed0: decUint(res, 3),
    tokensOwed1: decUint(res, 4),
  }
}

// Сколько токенов соответствует ликвидности в диапазоне при текущей цене.
// Формулы из Uniswap: amount0 = L*(1/sqrtP - 1/sqrtB), amount1 = L*(sqrtP - sqrtA).
export function amountsForLiquidity(sqrtP, tickLower, tickUpper, liquidity) {
  const Q96 = 1n << 96n
  const sqrtA = sqrtAtTick(tickLower)
  const sqrtB = sqrtAtTick(tickUpper)
  if (liquidity === 0n) return { amount0: 0n, amount1: 0n }

  let amount0 = 0n
  let amount1 = 0n
  if (sqrtP <= sqrtA) {
    // цена ниже диапазона — вся позиция в token0
    amount0 = (liquidity * Q96 * (sqrtB - sqrtA)) / (sqrtB * sqrtA)
  } else if (sqrtP >= sqrtB) {
    // цена выше диапазона — вся позиция в token1
    amount1 = (liquidity * (sqrtB - sqrtA)) / Q96
  } else {
    amount0 = (liquidity * Q96 * (sqrtB - sqrtP)) / (sqrtB * sqrtP)
    amount1 = (liquidity * (sqrtP - sqrtA)) / Q96
  }
  return { amount0, amount1 }
}

// sqrt(1.0001^tick) * 2^96. Целочисленно, через дробную степень.
export function sqrtAtTick(tick) {
  const Q96 = 1n << 96n
  const absTick = tick < 0 ? -tick : tick
  // 1.0001^(tick/2) = e^(tick/2 * ln(1.0001)); считаем в float и переводим.
  // Для UI-оценки точности хватает: расхождение меньше 1e-9.
  const v = Math.pow(1.0001, tick / 2) * Number(Q96)
  if (!isFinite(v) || v <= 0) return 1n
  return BigInt(Math.floor(v))
}

// Тик, ближайший к цене, кратный шагу. Нужен для создания диапазона.
export function tickFromPrice(price, spacing) {
  if (!isFinite(price) || price <= 0) return 0
  const t = Math.log(price) / Math.log(1.0001)
  return Math.round(t / spacing) * spacing
}

export function priceFromTick(tick) {
  return Math.pow(1.0001, tick)
}

// Ограничения тиков Uniswap V3.
export const MIN_TICK = -887272
export const MAX_TICK = 887272

export function clampTick(t, spacing) {
  const lo = Math.ceil(MIN_TICK / spacing) * spacing
  const hi = Math.floor(MAX_TICK / spacing) * spacing
  return Math.max(lo, Math.min(hi, t))
}
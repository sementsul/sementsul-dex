// Кодирование/декодирование ABI без внешних зависимостей.
// Всё, что нужно DEX-фронтенду: селекторы, uint256/address/bool, строки и динамические массивы.

import { keccak256, toHex } from 'viem'

export function selector(signature) {
  return keccak256(toHex(signature)).slice(0, 10)
}

export const SEL = {
  // ERC-20
  symbol: selector('symbol()'),
  name: selector('name()'),
  decimals: selector('decimals()'),
  totalSupply: selector('totalSupply()'),
  balanceOf: selector('balanceOf(address)'),
  allowance: selector('allowance(address,address)'),
  approve: selector('approve(address,uint256)'),
  transfer: selector('transfer(address,uint256)'),
  // Pancake V2
  getReserves: selector('getReserves()'),
  token0: selector('token0()'),
  token1: selector('token1()'),
  getPair: selector('getPair(address,address)'),
  // Своя фабрика: pairFor вычисляет адрес детерминированно (CREATE2), isPair —
  // проверка принадлежности. getPair у нас тоже есть, но pairFor дешевле:
  // он не читает хранилище, а считает адрес.
  pairFor: selector('pairFor(address,address)'),
  isPair: selector('isPair(address)'),
  allPairsLength: selector('allPairsLength()'),
  allPairsSlice: selector('allPairsSlice(uint256,uint256)'),
  // Авто-геттер публичного массива: есть и у Pancake, и у нас.
  allPairs: selector('allPairs(uint256)'),
  factory: selector('factory()'),
  getAmountsOut: selector('getAmountsOut(uint256,address[])'),
  swapExactTokensForTokens: selector('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)'),
  swapExactETHForTokens: selector('swapExactETHForTokens(uint256,address[],address,uint256)'),
  swapExactTokensForETH: selector('swapExactTokensForETH(uint256,uint256,address[],address,uint256)'),
  // Pancake V3
  slot0: selector('slot0()'),
  liquidity: selector('liquidity()'),
  fee: selector('fee()'),
  getPool: selector('getPool(address,address,uint24)'),
  // Своя V3-фабрика. После переделки на четыре тира её API совпадает с
  // Pancake/Uniswap: и getPool, и poolFor принимают тир комиссии третьим
  // аргументом. Одна фабрика обслуживает четыре пула на пару, поэтому тир
  // обязан передаваться везде — иначе мы попадём в чужой пул той же пары.
  // isPool проверяет принадлежность пула фабрике.
  poolFor: selector('poolFor(address,address,uint24)'),
  isPool: selector('isPool(address)'),
  tickSpacing: selector('tickSpacing()'),
  tickSpacingFor: selector('tickSpacingFor(uint24)'),
  feeTiers: selector('feeTiers(uint256)'),
  feeTiersLength: selector('feeTiersLength()'),
  quoteExactInputSingle: selector('quoteExactInputSingle((address,address,uint256,uint24,uint160))'),
  // ВНИМАНИЕ: у Pancake V3 роутера НЕ 7-польная версия (0x04e45aaf), а 8-польная
  // с deadline внутри структуры (0x414bf389). Проверено по байткоду роутера.
  exactInputSingle: selector('exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))'),
  multicall: selector('multicall(bytes[])'),
  unwrapWETH9: selector('unwrapWETH9(uint256,address)'),
  unwrapWETH9Amount: selector('unwrapWETH9(uint256)'),
  refundETH: selector('refundETH()'),

  // ---------- ликвидность ----------
  // V2: роутер сам переводит токены в пару и минтит LP-токены на адрес.
  addLiquidity: selector('addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)'),
  addLiquidityETH: selector('addLiquidityETH(address,uint256,uint256,uint256,address,uint256)'),
  removeLiquidity: selector('removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)'),
  removeLiquidityETH: selector('removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)'),

  // V2-пара напрямую: mint/burn в обход роутера. Нужны, когда пишем в пару сами.
  mint: selector('mint(address)'),
  burn: selector('burn(address)'),
  transferFrom: selector('transferFrom(address,address,uint256)'),

  // V3: позиция = владелец + диапазон тиков.
  mintV3: selector('mint(address,int24,int24,uint128)'),
  burnV3: selector('burn(int24,int24,uint128)'),
  collect: selector('collect(address,int24,int24,uint128,uint128)'),
  positions: selector('positions(bytes32)'),
  ticks: selector('ticks(int24)'),
  initializePrice: selector('initializePrice(uint160)'),
  createPool: selector('createPool(address,address,uint24)'),
  createPair: selector('createPair(address,address)'),
  allPoolsLength: selector('allPoolsLength()'),
  allPools: selector('allPools(uint256)'),
  getPoolCount: selector('allPoolsLength()'),

  // ---------- СВОЙ V3-роутер ----------
  // У нашего SementsulV3Router struct ExactInputParams состоит из ЧЕТЫРЁХ
  // полей (bytes path, recipient, amountIn, amountOutMinimum), а не из восьми,
  // как у Pancake/Uniswap, и маршрут упакован в path одной строкой.
  // Селекторы получаются разные (0xea7ec9c4 против 0x414bf389), поэтому
  // отправка «унисвопной» calldata в наш роутер падает на селекторе.
  // Проверено вызовом: 4-польная форма проходит, 8-польная откатывается.
  exactInputSingleOwn: selector('exactInputSingle((bytes,address,uint256,uint256),uint256)'),
  exactInputOwn: selector('exactInput((bytes,address,uint256,uint256),uint256)'),
  exactOutputSingleOwn: selector('exactOutputSingle((bytes,address,uint256,uint256),uint256)'),
  exactOutputOwn: selector('exactOutput((bytes,address,uint256,uint256),uint256)'),
  refundBNB: selector('refundBNB()'),
  unwrapWBNB: selector('unwrapWBNB(uint256,address)'),
  wrapBNB: selector('wrapBNB(uint256)'),
}

export function pad32(hex) {
  return hex.replace(/^0x/, '').padStart(64, '0')
}

export function encAddress(addr) {
  return pad32(addr.toLowerCase())
}

export function encUint(v) {
  const big = typeof v === 'bigint' ? v : BigInt(v)
  if (big < 0n) {
    // two's complement для int256 (используется в sqrtPriceLimitX96 = -1 как uint160 max)
    return (big + (1n << 256n)).toString(16).padStart(64, '0')
  }
  return big.toString(16).padStart(64, '0')
}

// Разбить hex-результат на 32-байтные слова.
export function words(hex) {
  if (!hex || hex === '0x') return []
  const s = hex.slice(2)
  const out = []
  for (let i = 0; i + 64 <= s.length; i += 64) out.push(s.slice(i, i + 64))
  return out
}

export function wordAt(hex, index) {
  const w = words(hex)
  return w[index]
}

export function decUint(hex, index = 0) {
  const w = wordAt(hex, index)
  return w ? BigInt('0x' + w) : 0n
}

export function decAddress(hex, index = 0) {
  const w = wordAt(hex, index)
  return w ? '0x' + w.slice(24) : null
}

export function decInt(hex, index = 0) {
  const v = decUint(hex, index)
  const half = 1n << 255n
  return v >= half ? v - (1n << 256n) : v
}

// Декодирование string (dynamic type): смещение, длина, байты.
export function decString(hex) {
  const w = words(hex)
  if (w.length < 3) return ''
  const offset = Number(BigInt('0x' + w[0]))
  const startByte = offset
  const wordsCount = Math.ceil(startByte / 32)
  const len = Number(BigInt('0x' + w[wordsCount]))
  if (!Number.isFinite(len) || len <= 0) return ''
  const s = hex.slice(2)
  const dataStart = (wordsCount + 1) * 64
  const raw = s.slice(dataStart, dataStart + len * 2)
  const bytes = new Uint8Array(raw.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? [])
  return new TextDecoder().decode(bytes)
}

// bytes4 из селектора -> слово
export function encBytes4(sel) {
  return sel.replace(/^0x/, '').padStart(8, '0').padEnd(64, '0')
}

// Сборка calldata из селектора и уже закодированных 32-байтных слов.
export function encodeCall(sel, ...parts) {
  return sel + parts.map((p) => p.replace(/^0x/, '')).join('')
}
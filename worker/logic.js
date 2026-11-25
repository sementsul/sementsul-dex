// Чистая логика разбора логов и агрегации свечей.
//
// Вынесена из index.js, чтобы её можно было проверить тестом на реальных
// данных из сети без запуска Cloudflare. Тест импортирует ровно этот файл,
// поэтому разойтись с продакшн-кодом он не может.

// topic0 события Swap у PancakePair (V2)
export const TOPIC_SWAP_V2 =
  '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822'

// topic0 события Swap у PancakeV3Pool
export const TOPIC_SWAP_V3 =
  '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83'

function words(data) {
  const s = data.slice(2)
  const out = []
  for (let i = 0; i + 64 <= s.length; i += 64) out.push(s.slice(i, i + 64))
  return out
}

// V2 Swap: amount0In, amount1In, amount0Out, amount1Out — все не-indexed, в data.
//
// Тонкость, найденная на реальных данных WBNB/USDT: 61 лог из 5751 — это
// flash-swap, где заём и возврат идут в ОДНОМ токене (например, in1>0 и out1>0).
// Считать для них цену как amountOut/amountIn бессмысленно — в журнал попал бы
// мусор порядка 1e12. Такие события помечаем kind='flash' и исключаем из
// свечей, объёма и статистики.
export function parseSwapV2(log) {
  // Фильтр по topic0 обязателен: публичный RPC publicnode отвергает любой
  // непустой topics как Invalid params, поэтому фильтровать приходится здесь.
  // Без этой проверки в базу попадут Sync, Transfer, Mint, Burn и прочие
  // события пары — у них тоже 4 слова в data, и они пройдут разбор.
  if (!log.topics?.[0] || log.topics[0].toLowerCase() !== TOPIC_SWAP_V2) return null

  const w = words(log.data)
  if (w.length < 4) return null

  const a0In = BigInt('0x' + w[0])
  const a1In = BigInt('0x' + w[1])
  const a0Out = BigInt('0x' + w[2])
  const a1Out = BigInt('0x' + w[3])

  const hasIn0 = a0In > 0n
  const hasIn1 = a1In > 0n
  const hasOut0 = a0Out > 0n
  const hasOut1 = a1Out > 0n

  // Обычный своп: ровно один вход, ровно один выход, и это разные токены.
  const normal = hasIn0 !== hasIn1 && hasOut0 !== hasOut1 && hasIn0 === hasOut1

  if (!normal) {
    return {
      protocol: 'v2',
      kind: 'flash',
      zeroForOne: hasIn0,
      amountIn: hasIn0 ? a0In : a1In,
      amountOut: hasOut1 ? a1Out : a0Out,
      price: 0n,
    }
  }

  const zeroForOne = hasIn0
  const amountIn = zeroForOne ? a0In : a1In // в токене входа
  const amountOut = zeroForOne ? a1Out : a0Out // в токене выхода

  // Цена ВСЕГДА в token1 за token0, независимо от направления.
  // При zeroForOne вход в token0, выход в token1 -> price = out/in.
  // При обратном свопе вход в token1, выход в token0 -> price = in/out.
  // Если это не учесть, половина сделок попадёт в журнал с перевёрнутой ценой
  // (у WBNB/USDT это 548 вместо 1/548) и график станет пилообразным.
  const price = zeroForOne
    ? (amountOut * 10n ** 18n) / amountIn
    : (amountIn * 10n ** 18n) / amountOut

  return {
    protocol: 'v2',
    kind: 'swap',
    zeroForOne,
    amountIn,
    amountOut,
    price,
  }
}

// V3 Swap: amount0, amount1, sqrtPriceX96, liquidity, tick
export function parseSwapV3(log) {
  // См. комментарий в parseSwapV2: фильтруем по topic0 здесь, потому что
  // не каждый RPC умеет фильтровать по темам.
  if (!log.topics?.[0] || log.topics[0].toLowerCase() !== TOPIC_SWAP_V3) return null

  const w = words(log.data)
  if (w.length < 5) return null

  const amount0 = BigInt('0x' + w[0])
  const amount1 = BigInt('0x' + w[1])
  const sqrtPriceX96 = BigInt('0x' + w[2])
  const tick = Number(BigInt('0x' + w[4]))

  // amount0/amount1 — int256 со знаком; для направления смотрим на amount0.
  const negative0 = amount0 >= 1n << 255n
  const zeroForOne = !negative0 && amount0 > 0n

  return {
    protocol: 'v3',
    kind: 'swap',
    zeroForOne,
    amountIn: 0n,
    amountOut: 0n,
    sqrtPriceX96,
    tick,
    // Цена token1 за token0, масштаб 1e18: (sqrtP / 2^96)^2
    price: (sqrtPriceX96 * sqrtPriceX96 * 10n ** 18n) / (1n << 192n),
  }
}

// Собрать OHLCV-свечи из сделок.
// Сделки на вход могут быть в любом порядке, поэтому open/close определяем
// по ts, а не по позиции в массиве. Возвращает свечи по возрастанию времени.
export function aggregateCandles(trades, bucketSeconds) {
  if (!trades?.length) return []

  // Сначала сортируем по времени: от этого зависит open/close.
  const sorted = [...trades].sort((a, b) => a.ts - b.ts)

  const groups = new Map()
  for (const t of sorted) {
    const b = Math.floor(t.ts / bucketSeconds) * bucketSeconds
    if (!groups.has(b)) groups.set(b, [])
    groups.get(b).push(t)
  }

  const candles = []
  for (const [bucket, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const prices = list.map((t) => Number(t.price) / 1e18)
    candles.push({
      time: bucket,
      open: prices[0],
      high: Math.max(...prices),
      low: Math.min(...prices),
      close: prices[prices.length - 1],
      trades: list.length,
      volume: list.reduce((s, t) => s + Number(t.volume ?? 0), 0),
    })
  }
  return candles
}
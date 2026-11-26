// Маршрутизация и котирование.
//
// Принцип: V2 считаем локально (формула x*y=k точна до wei), V3 — через QuoterV2,
// потому что приближение по slot0 не учитывает проход по тикам и даёт ошибку ~0.1%,
// а это реальные деньги пользователя.
//
// Всё чтение идёт батчами через MEV Guard: один HTTP-запрос на все тиры одной пары.

import { batchCall, call } from './rpc.js'
import { SEL, encAddress, encUint, decAddress, decUint, words } from './abi.js'
import {
  WBNB,
  USDT,
  V2_FACTORY,
  V2_ROUTER,
  V3_FACTORY,
  V3_ROUTER,
  V3_QUOTER,
  V3_FEE_TIERS,
  NATIVE,
  HAS_OWN_V3,
  V2_FEE,
} from './chain.js'
import { getAmountOutV2 } from './pools.js'

const ZERO = '0x0000000000000000000000000000000000000000'

// Хаб-токены для двух- и трёхшаговых маршрутов.
const HUBS = [WBNB, USDT]

// ---------- кэш открытия пулов ----------
const discoverCache = new Map()
const discoverCacheTs = new Map()
const DISCOVER_TTL = 10 * 60 * 1000

function pairKey(a, b) {
  return [a.toLowerCase(), b.toLowerCase()].sort().join(':')
}

// BNB — не токен, в пулах его представляет WBNB.
export function toPoolToken(addr) {
  return addr === NATIVE ? WBNB : addr
}

export function isNative(addr) {
  return addr === NATIVE
}

async function discoverPools(tokenA, tokenB) {
  const a = toPoolToken(tokenA)
  const b = toPoolToken(tokenB)
  const key = pairKey(a, b)
  const now = Date.now()
  if (discoverCache.has(key) && now - (discoverCacheTs.get(key) ?? 0) < DISCOVER_TTL) {
    return discoverCache.get(key)
  }

  const calls = [
    { to: V2_FACTORY, data: SEL.getPair + encAddress(a) + encAddress(b) },
    // Теперь и своя фабрика, и Pancake отвечают на getPool с тиром: после
    // переделки на четыре тира отдельная ветка для своей фабрики не нужна.
    ...V3_FEE_TIERS.map((fee) => ({
      to: V3_FACTORY,
      data: SEL.getPool + encAddress(a) + encAddress(b) + encUint(fee),
    })),
  ]
  const res = await batchCall(calls)

  const pools = []
  const v2 = decAddress(res[0])
  if (v2 && v2 !== ZERO) pools.push({ protocol: 'v2', address: v2 })
  res.slice(1).forEach((hex, i) => {
    const addr = decAddress(hex)
    if (addr && addr !== ZERO) pools.push({ protocol: 'v3', address: addr, fee: V3_FEE_TIERS[i] })
  })

  discoverCache.set(key, pools)
  discoverCacheTs.set(key, now)
  return pools
}

async function loadV2States(pools) {
  if (!pools.length) return []
  const calls = []
  pools.forEach((p) => {
    calls.push({ to: p.address, data: SEL.getReserves })
    calls.push({ to: p.address, data: SEL.token0 })
    calls.push({ to: p.address, data: SEL.token1 })
  })
  const res = await batchCall(calls)
  const out = []
  pools.forEach((p, i) => {
    const r = res[i * 3]
    const t0 = res[i * 3 + 1]
    const t1 = res[i * 3 + 2]
    if (!r || !t0 || !t1) return
    const w = words(r)
    out.push({
      ...p,
      token0: decAddress(t0),
      token1: decAddress(t1),
      reserve0: BigInt('0x' + w[0]),
      reserve1: BigInt('0x' + w[1]),
    })
  })
  return out.filter((p) => p.reserve0 > 0n && p.reserve1 > 0n)
}

// Все V3-квоты для пары по всем тирам — одним батчем к QuoterV2.
async function quoteV3AllTiers(tokenIn, tokenOut, amountIn) {
  const a = toPoolToken(tokenIn)
  const b = toPoolToken(tokenOut)
  const calls = V3_FEE_TIERS.map((fee) => ({
    to: V3_QUOTER,
    data:
      SEL.quoteExactInputSingle +
      encAddress(a) +
      encAddress(b) +
      encUint(amountIn) +
      encUint(fee) +
      encUint(0n),
  }))
  const res = await batchCall(calls)
  const out = []
  res.forEach((hex, i) => {
    if (!hex) return
    const amountOut = decUint(hex, 0)
    if (amountOut === 0n) return
    out.push({ protocol: 'v3', fee: V3_FEE_TIERS[i], amountOut, gasEstimate: decUint(hex, 1) })
  })
  return out
}

function candidatePaths(tokenIn, tokenOut) {
  const tin = tokenIn.toLowerCase()
  const tout = tokenOut.toLowerCase()
  const paths = [[tin, tout]]
  for (const hub of HUBS) {
    const h = hub.toLowerCase()
    if (h !== tin && h !== tout) paths.push([tin, h, tout])
  }
  const hubSet = new Set(HUBS.map((h) => h.toLowerCase()))
  if (!hubSet.has(tin) && !hubSet.has(tout) && tin !== NATIVE && tout !== NATIVE) {
    const w = WBNB.toLowerCase()
    const u = USDT.toLowerCase()
    paths.push([tin, w, u, tout])
    paths.push([tin, u, w, tout])
  }
  return paths
}

async function bestHop(tokenIn, tokenOut, amountIn, { allowV3 = true } = {}) {
  const pools = await discoverPools(tokenIn, tokenOut)
  if (!pools.length) return null

  const candidates = []

  const v2pools = pools.filter((p) => p.protocol === 'v2')
  if (v2pools.length) {
    const states = await loadV2States(v2pools)
    const inTok = toPoolToken(tokenIn).toLowerCase()
    for (const s of states) {
      const inIsT0 = s.token0.toLowerCase() === inTok
      const rIn = inIsT0 ? s.reserve0 : s.reserve1
      const rOut = inIsT0 ? s.reserve1 : s.reserve0
      const out = getAmountOutV2(amountIn, rIn, rOut)
      if (out > 0n) candidates.push({ protocol: 'v2', pool: s, amountOut: out, gasEstimate: 0n })
    }
  }

  if (allowV3 && pools.some((p) => p.protocol === 'v3')) {
    const v3 = await quoteV3AllTiers(tokenIn, tokenOut, amountIn)
    for (const q of v3) {
      candidates.push({ ...q, pool: pools.find((p) => p.protocol === 'v3' && p.fee === q.fee) })
    }
  }

  if (!candidates.length) return null
  candidates.sort((a, b) => (b.amountOut > a.amountOut ? 1 : b.amountOut < a.amountOut ? -1 : 0))
  return candidates[0]
}

// Полная котировка. Перебираем только ИСПОЛНИМЫЕ маршруты:
//  - весь путь по V2  -> один вызов swapExact*ForTokens в V2-роутере;
//  - один хоп по V3   -> exactInputSingle в V3-роутере.
//
// Смешанные маршруты (V3-хоп + V2-хоп) технически дают лучший курс, но требуют
// Universal Router с Permit2, которого в этой сборке нет. Мы намеренно их не
// показываем: лучше честный курс, который исполнится, чем красивый, который нет.
// Замер на живой сети: разница между смешанным и all-V2 для USDT->WBNB — 0.0002%.
export async function quote(tokenIn, tokenOut, amountIn) {
  if (!amountIn || amountIn <= 0n) return null
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) return null

  const paths = candidatePaths(tokenIn, tokenOut)
  let best = null

  for (const path of paths) {
    for (const family of ['v2', 'v3']) {
      const route = await buildRoute(path, amountIn, family)
      if (!route) continue
      if (!best || route.amountOut > best.amountOut) best = route
    }
  }

  if (!best) return null

  return {
    ...best,
    priceImpactBps: computePriceImpact(best, amountIn),
  }
}

// Собрать маршрут заданного семейства по указанному пути.
// family='v2' — все хопы только через V2; family='v3' — ровно один V3-хоп.
async function buildRoute(path, amountIn, family) {
  // V3-роутер в этой сборке умеет только одиночный хоп.
  if (family === 'v3' && path.length !== 2) return null

  let amounts = [amountIn]
  const hops = []

  for (let i = 0; i < path.length - 1; i++) {
    const hop = await bestHop(path[i], path[i + 1], amounts[i], { allowV3: family === 'v3' })
    if (!hop) return null
    // Семейство должно совпасть: в v2-маршрут не пускаем V3-хоп и наоборот.
    if (hop.protocol !== family) return null

    hops.push({
      from: path[i],
      to: path[i + 1],
      protocol: hop.protocol,
      pool: hop.pool,
      fee: hop.fee,
      amountIn: amounts[i],
      amountOut: hop.amountOut,
      gasEstimate: hop.gasEstimate,
    })
    amounts.push(hop.amountOut)
  }

  const out = amounts[amounts.length - 1]
  if (out <= 0n) return null
  return { path, hops, amounts, amountOut: out, family }
}

// Price impact без учёта комиссии пула — так его показывают Pancake и Uniswap.
// Для V2 точная формула: impact = a_eff / (rIn + a_eff), где a_eff — сумма после комиссии.
// Для V3 берём отклонение исполнения от mid-цены, восстановленной по котировке.
function computePriceImpact(route, amountIn) {
  let impact = 0
  const weights = []

  for (const hop of route.hops) {
    if (hop.protocol === 'v2') {
      const s = hop.pool
      const inIsT0 = s.token0.toLowerCase() === hop.from.toLowerCase() || (hop.from === NATIVE && s.token0.toLowerCase() === WBNB.toLowerCase())
      const rIn = inIsT0 ? s.reserve0 : s.reserve1
      if (rIn === 0n) continue
      // Ставка из деплоя, а не литерал 0.25%: у своей биржи она другая.
      const aEff = (hop.amountIn * (1_000_000n - V2_FEE)) / 1_000_000n
      const hopImpact = Number((aEff * 10000n) / (rIn + aEff))
      impact += hopImpact
      weights.push(rIn)
    } else {
      // V3: исполнение уже с комиссией. Сравниваем с курсом без комиссии.
      const fee = BigInt(hop.fee ?? 2500)
      const after = hop.amountIn - (hop.amountIn * fee) / 1_000_000n
      if (after === 0n) continue
      const idealNoFee = (hop.amountOut * hop.amountIn) / after
      if (idealNoFee === 0n) continue
      const hopImpact = Number(((idealNoFee - hop.amountOut) * 10000n) / idealNoFee)
      impact += hopImpact
    }
  }

  // Комиссия как отдельная строка UI, не часть impact.
  return Math.max(0, Math.round(impact))
}

// Суммарная комиссия маршрута в bps — для отображения пользователю.
//
// У V2 ставка в единицах 1e-6, поэтому в bps переводим делением на 100
// (1 bps = 100 единиц 1e-6). У V3 fee уже задан в тех же единицах 1e-6.
export function routeFeeBps(route) {
  let bps = 0
  for (const hop of route.hops) {
    if (hop.protocol === 'v2') bps += Math.round(Number(V2_FEE) / 100)
    else bps += Math.round((hop.fee ?? 2500) / 100)
  }
  return bps
}

// ---------- сборка транзакции ----------

export function buildSwapTx({ route, tokenIn, tokenOut, recipient, slippageBps, deadlineSec = 600 }) {
  const amountIn = route.amounts[0]
  const minOut = (route.amountOut * BigInt(10000 - slippageBps)) / 10000n
  const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineSec)

  const nativeIn = isNative(tokenIn)
  const nativeOut = isNative(tokenOut)
  const allV2 = route.hops.every((h) => h.protocol === 'v2')

  // Приводим путь к WBNB вместо BNB — так его видят пулы.
  const path = route.path.map((a) => toPoolToken(a))

  if (allV2) {
    // encodeAddressArray уже содержит слово длины — не дублируем его.
    const pathEnc = encodeAddressArray(path)

    if (nativeIn) {
      // swapExactETHForTokens(minOut, path, to, deadline) — value = amountIn
      const data =
        SEL.swapExactETHForTokens +
        encUint(minOut) +
        encUint(0x80) +
        encAddress(recipient) +
        encUint(deadline) +
        pathEnc
      return { to: V2_ROUTER, data, value: amountIn, kind: 'v2-native-in' }
    }
    if (nativeOut) {
      // swapExactTokensForETH(amountIn, minOut, path, to, deadline)
      const data =
        SEL.swapExactTokensForETH +
        encUint(amountIn) +
        encUint(minOut) +
        encUint(0xa0) +
        encAddress(recipient) +
        encUint(deadline) +
        pathEnc
      return { to: V2_ROUTER, data, value: 0n, kind: 'v2-native-out' }
    }
    const data =
      SEL.swapExactTokensForTokens +
      encUint(amountIn) +
      encUint(minOut) +
      encUint(0xa0) +
      encAddress(recipient) +
      encUint(deadline) +
      pathEnc
    return { to: V2_ROUTER, data, value: 0n, kind: 'v2-multi' }
  }

  // V3 single-hop
  if (route.hops.length === 1) {
    const hop = route.hops[0]
    const inTok = toPoolToken(tokenIn)

    // Нативный BNB на входе наш V3-роутер обслужить не может.
    //
    // Почему: роутер списывает вход через transferFrom(payer, pool, owed), где
    // payer = msg.sender. Внутри multicall (delegatecall) msg.sender — это
    // пользователь, а не роутер. Значит роутер попытается списать WBNB с
    // пользователя, хотя тот прислал BNB и WBNB у него нет. wrapBNB кладёт
    // WBNB на баланс роутера, но обмен его оттуда не берёт.
    //
    // Проверено вызовом: с выданным approve на WBNB тот же calldata проходит,
    // без него — откат. То есть дело именно в плательщике.
    //
    // Чинится только правкой контракта (платить с address(this), когда вход
    // был нативным), а это передеплой роутера и смена адреса. Пока честнее
    // вернуть ошибку, чем отправить заведомо падающую транзакцию.
    if (nativeIn) {
      throw new Error(
        'Обмен BNB через пул V3 пока недоступен: роутер списывает WBNB с вашего адреса, ' +
          'а не берёт завернутый BNB со своего. Обменяйте BNB на WBNB в пуле V2 и торгуйте WBNB.'
      )
    }

    // Нативный BNB на выходе: своп в WBNB на адрес роутера, затем unwrapWBNB.
    if (nativeOut) {
      const pathHex = encodeV3Path([inTok, WBNB], [hop.fee])
      const inner = encodeExactInputSingleOwn({
        pathHex,
        recipient: ADDRESS_THIS,
        amountIn,
        minOut,
        deadline,
      })
      const unwrap = SEL.unwrapWBNB + encUint(minOut) + encAddress(recipient)
      return {
        to: V3_ROUTER,
        data: multicallData([inner, unwrap]),
        value: 0n,
        kind: 'v3-native-out',
        fee: hop.fee,
      }
    }

    const pathHex = encodeV3Path([inTok, toPoolToken(tokenOut)], [hop.fee])
    const data = encodeExactInputSingleOwn({
      pathHex,
      recipient,
      amountIn,
      minOut,
      deadline,
    })
    return { to: V3_ROUTER, data, value: 0n, kind: 'v3-single', fee: hop.fee }
  }

  // Смешанный multi-hop (V2 + V3 в одном маршруте) требует Universal Router.
  return null
}

// Внутри multicall промежуточный WBNB остаётся на роутере,
// поэтому получателем указываем сам роутер, а не заглушку.
const ADDRESS_THIS = V3_ROUTER

// multicall(bytes[]) из набора уже закодированных вызовов.
//
// ABI-раскладка: [смещение на массив][длина n][n offset-слов][конкатенация
// (длина, выровненные данные) для каждого элемента]. Смещение внутри массива
// считается от начала массива (то есть от слова с длиной n), а не от начала calldata.
function multicallData(calls) {
  const n = calls.length
  let offsets = ''
  let body = ''
  // Массив начинается сразу после слова-смещения (32 байта), поэтому первый
  // элемент лежит на n*32 от начала массива.
  let running = n * 32

  for (const c of calls) {
    offsets += running.toString(16).padStart(64, '0')
    const bytes = c.replace(/^0x/, '')
    const len = bytes.length / 2
    const padded = bytes.padEnd(Math.ceil(len / 32) * 64, '0')
    body += len.toString(16).padStart(64, '0') + padded
    // Смещения считаются в БАЙТАХ: padded — это hex-строка, поэтому делим на 2.
    running += 32 + padded.length / 2
  }

  return SEL.multicall + encUint(0x20) + encUint(n) + offsets + body
}

function encodeAddressArray(addresses) {
  let out = encUint(addresses.length)
  for (const a of addresses) out += encAddress(a)
  return out
}

// ---------- кодирование вызовов своего V3-роутера ----------
//
// У SementsulV3Router маршрут упакован в один bytes path:
//   token(20) + fee(3) + token(20) + [fee(3) + token(20)]...
// Это отличается от Pancake/Uniswap, где struct ExactInputParams состоит из
// восьми полей по отдельности. Отправлять «унисвопную» calldata нельзя:
// селектор другой, вызов падает.
export function encodeV3Path(tokens, fees) {
  let out = ''
  for (let i = 0; i < tokens.length; i++) {
    out += tokens[i].toLowerCase().replace(/^0x/, '')
    if (i < fees.length) out += Number(fees[i]).toString(16).padStart(6, '0')
  }
  return out
}

// exactInputSingle(ExactInputParams, deadline), где
// ExactInputParams = (bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum).
//
// Голова: [0x20 смещение на tuple][deadline]
// Внутри tuple: [смещение path][recipient][amountIn][minOut][длина path][path]
function encodeExactInputSingleOwn({ pathHex, recipient, amountIn, minOut, deadline }) {
  const pathBytes = pathHex.replace(/^0x/, '')
  const pathPadded = pathBytes.padEnd(Math.ceil(pathBytes.length / 64) * 64, '0')

  // Tuple начинается после двух слов головы (смещение на tuple + deadline).
  // Внутри tuple четыре статических поля по 32 байта, значит path лежит
  // на смещении 4*32 = 128 от начала tuple.
  const tuple =
    encUint(0x80) + // смещение на path внутри tuple
    encAddress(recipient) +
    encUint(amountIn) +
    encUint(minOut) +
    encUint(pathBytes.length / 2) + // длина path в байтах
    pathPadded

  return SEL.exactInputSingleOwn + encUint(0x40) + encUint(deadline) + tuple
}

function encodeExactInputOwn({ pathHex, recipient, amountIn, minOut, deadline }) {
  // exactInput принимает ту же структуру, поэтому раскладка совпадает.
  // Смещение на tuple — 0x40, потому что в голове два слова (смещение и
  // deadline), а tuple лежит сразу за ними.
  const pathBytes = pathHex.replace(/^0x/, '')
  return (
    SEL.exactInputOwn +
    encUint(0x40) +
    encUint(deadline) +
    encUint(0x80) +
    encAddress(recipient) +
    encUint(amountIn) +
    encUint(minOut) +
    encUint(pathBytes.length / 2) +
    pathBytes.padEnd(Math.ceil(pathBytes.length / 64) * 64, '0')
  )
}

export async function spotPrice(tokenIn, tokenOut, decimalsIn = 18, decimalsOut = 18) {
  const one = 10n ** BigInt(decimalsIn)
  const q = await quote(tokenIn, tokenOut, one).catch(() => null)
  if (!q) return null
  return Number(q.amountOut) / 10 ** decimalsOut
}
// Cloudflare Worker: API индексатора сделок PancakeSwap для SML.
//
// Что здесь есть и чего нет:
//
//   Воркер ТОЛЬКО ЧИТАЕТ. Сканирование блоков выполняется в GitHub Actions
//   (scripts/index.mjs), потому что из воркера это принципиально невозможно:
//
//   - eth_getLogs публичные BSC-RPC не отдают никому из Cloudflare: общие
//     egress-IP троттлятся как один клиент, ответ "Rate limit exceeded";
//   - eth_getBlockReceipts работает, но требует ~2 мс CPU на блок (разбор всех
//     логов блока, ~600 штук). На Free-плане лимит CPU — 10 мс на вызов, то
//     есть воркер падает на 1000 блоках с "exceeded CPU time limit";
//   - limits.subrequests и limits.cpu_ms на Free-плане не настраиваются
//     (ошибка 100328).
//
//   Поэтому воркер отдаёт готовые данные из D1 — это дешёвые запросы.
//
// Эндпоинты:
//   GET /api/health
//   GET /api/candles?pair=0x...&interval=5m|15m|1h|4h|1d&limit=200
//   GET /api/trades?pair=0x...&limit=20
//   GET /api/stats?pair=0x...

import { TOPIC_SWAP_V2, TOPIC_SWAP_V3, parseSwapV2, parseSwapV3 } from './logic.js'

const PAIR_SML_WBNB = '0xd5394617f4a0222b7c30a3e46d740969d0acfddc'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  })
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    try {
      switch (url.pathname) {
        case '/api/health':
          return json({ ok: true, ts: Date.now() })
        case '/api/candles':
          return await handleCandles(url, env)
        case '/api/trades':
          return await handleTrades(url, env)
        case '/api/stats':
          return await handleStats(url, env)
        default:
          return json({ error: 'не найдено' }, 404)
      }
    } catch (e) {
      console.error('worker error', e?.stack ?? e)
      return json({ error: e.message ?? String(e) }, 500)
    }
  },
}

// ---------- API ----------

const INTERVALS = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }

async function handleCandles(url, env) {
  const pair = url.searchParams.get('pair') ?? PAIR_SML_WBNB
  const interval = url.searchParams.get('interval') ?? '1h'
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 1000)

  const bucket = INTERVALS[interval]
  if (!bucket) return json({ error: 'неизвестный интервал', allowed: Object.keys(INTERVALS) }, 400)

  // Свечи собираем в SQL: группировка по номеру бакета.
  // kind='swap' обязателен: flash-свопы дают нулевую/мусорную цену и не должны
  // попадать ни в OHLC, ни в объём.
  const { results } = await env.DB.prepare(
    `SELECT
       (ts / ?) * ? AS bucket,
       MIN(ts) AS ts,
       AVG(CAST(price AS REAL)) AS _avg,
       MIN(CAST(price AS REAL)) AS low,
       MAX(CAST(price AS REAL)) AS high,
       COUNT(*) AS trades,
       SUM(CAST(amount_in AS REAL)) AS volume
     FROM trades
     WHERE pair = ?
       AND kind = 'swap'
       AND ts > (strftime('%s','now') - ? * 60)
     GROUP BY bucket
     ORDER BY bucket DESC
     LIMIT ?`
  )
    .bind(bucket, bucket, pair, bucket * limit, limit)
    .all()

  // open/close требуют первой и последней сделки в бакете — досчитываем отдельно.
  const candles = []
  for (const r of results ?? []) {
    const open = await env.DB.prepare(
      `SELECT price FROM trades WHERE pair = ? AND kind = 'swap' AND (ts / ?) * ? = ? ORDER BY ts ASC, log_index ASC LIMIT 1`
    )
      .bind(pair, bucket, bucket, r.bucket)
      .first()
    const close = await env.DB.prepare(
      `SELECT price FROM trades WHERE pair = ? AND kind = 'swap' AND (ts / ?) * ? = ? ORDER BY ts DESC, log_index DESC LIMIT 1`
    )
      .bind(pair, bucket, bucket, r.bucket)
      .first()

    candles.push({
      time: r.ts,
      open: Number(open?.price ?? r._avg),
      high: r.high,
      low: r.low,
      close: Number(close?.price ?? r._avg),
      trades: r.trades,
      volume: r.volume,
    })
  }

  return json({ pair, interval, candles })
}

async function handleTrades(url, env) {
  const pair = url.searchParams.get('pair') ?? PAIR_SML_WBNB
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 200)

  const { results } = await env.DB.prepare(
    `SELECT tx_hash, log_index, block, ts, protocol, kind, zero_for_one,
            amount_in, amount_out, price
     FROM trades
     WHERE pair = ?
     ORDER BY block DESC, log_index DESC
     LIMIT ?`
  )
    .bind(pair, limit)
    .all()

  return json({ pair, trades: results ?? [] })
}

async function handleStats(url, env) {
  const pair = url.searchParams.get('pair') ?? PAIR_SML_WBNB

  const last = await env.DB.prepare(
    `SELECT price, ts FROM trades WHERE pair = ? AND kind = 'swap' ORDER BY block DESC, log_index DESC LIMIT 1`
  )
    .bind(pair)
    .first()

  const day = await env.DB.prepare(
    `SELECT COUNT(*) AS trades,
            SUM(CAST(amount_in AS REAL)) AS volume,
            MIN(CAST(price AS REAL)) AS low,
            MAX(CAST(price AS REAL)) AS high
     FROM trades
     WHERE pair = ? AND kind = 'swap' AND ts > (strftime('%s','now') - 86400)`
  )
    .bind(pair)
    .first()

  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM trades WHERE pair = ? AND kind = 'swap'`
  )
    .bind(pair)
    .first()

  const sync = await env.DB.prepare(`SELECT last_block, updated_at FROM sync_state WHERE pair = ?`)
    .bind(pair)
    .first()

  return json({
    pair,
    lastPrice: last?.price ?? null,
    lastTradeTs: last?.ts ?? null,
    day: day ?? { trades: 0, volume: 0, low: null, high: null },
    totalTrades: total?.n ?? 0,
    indexedToBlock: sync?.last_block ?? null,
    indexedAt: sync?.updated_at ?? null,
  })
}
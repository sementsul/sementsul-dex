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

// Пул по умолчанию — свой USDT/WBNB в V3 (0.05%).
//
// Раньше здесь стоял чужой пул SML/WBNB. Он не имеет отношения к нашей бирже,
// поэтому запрос без параметра pair отдавал историю чужого рынка: интерфейс
// выглядел наполненным, но цифры были не наши.
const DEFAULT_PAIR = '0x37c7702b589c69d1e4f4ad32e19f372ed6780278'

// Адрес пары приводим к нижнему регистру ВСЕГДА.
//
// Причина — реальная поломка. Индексатор писал pair в EIP-55-виде
// (0x37c7702B589c69D1E4f4ad32E19f372ED6780278), а фронтенд брал адрес из
// deployments.js, где та же строка записана с другой контрольной суммой
// (…D1e4…). SQLite сравнивает TEXT побайтово, поэтому `pair = ?` не находил
// НИ ОДНОЙ строки: эндпоинты отдавали пустые списки при живых данных в базе.
// Ошибка была невидимой — 200 OK с пустым массивом, а не 500.
//
// Сравнение регистронезависимо через LOWER(pair) не годится: оно снимает
// индекс и заставляет читать всю таблицу, а именно это и выжгло лимит D1.
// Поэтому нормализуем и хранение, и запрос к нижнему регистру — тогда индекс
// (pair, kind, ts DESC) продолжает работать.
function normPair(raw) {
  return String(raw ?? DEFAULT_PAIR).trim().toLowerCase()
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extraHeaders },
  })
}

// Кеш ответов на границе Cloudflare.
//
// Зачем: данные индексатора меняются только когда отработает GitHub Actions
// (раз в несколько минут), а фронтенд спрашивает их раз в минуту с каждого
// открытого таба. Без кеша каждый такой запрос шёл в D1 и читал строки из
// суточного лимита. С кешем один поход в базу обслуживает всех посетителей
// в пределах TTL, и расход перестаёт зависеть от числа открытых вкладок.
//
// TTL подобран под частоту индексатора: чаще, чем он обновляет данные,
// отдавать свежие всё равно нечего.
const CACHE_TTL = {
  '/api/trades': 30,
  '/api/stats': 60,
  '/api/candles': 120,
}

function cacheKeyFor(request, pathname) {
  // Ключ обязан включать query: pair, interval и limit меняют ответ.
  const url = new URL(request.url)
  return new Request(`https://cache.sementsul.net${pathname}${url.search}`, { method: 'GET' })
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    try {
      // Зеркало отдаётся префиксом /mirror/. Проверяем до switch: путь внутри
      // зеркала произвольный (assets/…, sanctions/…), перечислять его нельзя.
      if (url.pathname === '/mirror' || url.pathname.startsWith('/mirror/')) {
        return await handleMirror(request, url)
      }

      switch (url.pathname) {
        case '/api/health':
          return json({ ok: true, ts: Date.now() })
        case '/api/candles':
          return await cached(request, env, ctx, url.pathname, (u) => handleCandles(u, env))
        case '/api/trades':
          return await cached(request, env, ctx, url.pathname, (u) => handleTrades(u, env))
        case '/api/stats':
          return await cached(request, env, ctx, url.pathname, (u) => handleStats(u, env))
        default:
          return json({ error: 'не найдено' }, 404)
      }
    } catch (e) {
      console.error('worker error', e?.stack ?? e)

      // Исчерпанный суточный лимит D1 — это не поломка кода, а состояние
      // аккаунта. Отдаём 503 и честный текст, чтобы фронтенд мог показать
      // «история временно недоступна» вместо вечной загрузки, а в логах
      // не было ложной тревоги «worker error».
      const msg = String(e?.message ?? e)
      if (msg.includes('exceeded D1') || msg.includes('daily row read limit')) {
        return json(
          {
            error: 'история сделок временно недоступна: исчерпан суточный лимит чтения D1',
            code: 'D1_LIMIT',
            retryAfter: secondsUntilUtcMidnight(),
          },
          503,
          { 'retry-after': String(secondsUntilUtcMidnight()) }
        )
      }

      return json({ error: msg }, 500)
    }
  },
}

// Сколько секунд осталось до полуночи UTC — момента сброса суточного лимита D1.
function secondsUntilUtcMidnight() {
  const now = Date.now()
  const next = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate() + 1
  )
  return Math.max(1, Math.ceil((next - now) / 1000))
}

// Отдать ответ из кеша или выполнить обработчик и положить результат в кеш.
async function cached(request, env, ctx, pathname, handler) {
  const ttl = CACHE_TTL[pathname]
  // Кеш доступен не всегда (например, в локальном miniflare без кеша),
  // поэтому отсутствие caches не должно ломать запрос.
  const cache = typeof caches !== 'undefined' ? caches.default : null
  const key = cache ? cacheKeyFor(request, pathname) : null

  if (cache && key) {
    const hit = await cache.match(key)
    if (hit) {
      // Помечаем, что ответ из кеша: это видно в заголовках и упрощает отладку.
      const res = new Response(hit.body, hit)
      res.headers.set('x-cache', 'HIT')
      return res
    }
  }

  const url = new URL(request.url)
  const res = await handler(url)

  // Ошибки не кешируем: иначе исчерпанный лимит D1 «залипнет» на TTL.
  if (!cache || !key || !res.ok) return res

  // Кешируем на ГРАНИЦЕ, но не в браузере.
  //
  // max-age=0 + must-revalidate: браузер обязан переспросить при каждом
  // обращении, поэтому данные не застревают у пользователя. s-maxage держит
  // ответ на границе Cloudflare — там кеш и нужен, он снимает нагрузку с D1.
  //
  // Раньше здесь стояло `max-age=${ttl}` и это уже приводило к поломке: в
  // интерфейсе висели сделки 19-часовой давности, хотя API отдавал свежие.
  // Проверялось так: обычный fetch возвращал 1140 минут, а тот же запрос с
  // случайным параметром — 17 минут. Разница только в HTTP-кеше браузера.
  //
  // Ещё раньше заголовок ставился лишь на копию для кеша, а клиенту уходил
  // ответ без него — тогда Cloudflare подставлял browser_cache_ttl зоны
  // (14400 секунд), и ситуация была ещё хуже.
  res.headers.set(
    'cache-control',
    `public, max-age=0, s-maxage=${ttl}, must-revalidate`
  )
  res.headers.set('x-cache', 'MISS')

  // В кеш кладём отдельную копию: тело ответа уже отдаётся клиенту.
  const toCache = new Response(res.clone().body, res)
  ctx?.waitUntil?.(cache.put(key, toCache))

  return res
}

// ---------- API ----------

const INTERVALS = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 }

async function handleCandles(url, env) {
  const pair = normPair(url.searchParams.get('pair'))
  const interval = url.searchParams.get('interval') ?? '1h'
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 200), 1000)

  const bucket = INTERVALS[interval]
  if (!bucket) return json({ error: 'неизвестный интервал', allowed: Object.keys(INTERVALS) }, 400)

  // Свечи собираем ОДНИМ запросом.
  //
  // Раньше здесь был цикл: агрегат по бакетам, а затем на КАЖДУЮ свечу ещё по
  // два запроса за open и close. При limit=200 это 1 + 400 = 401 обращение к D1
  // за один HTTP-вызов. Каждый из этих запросов фильтровал по выражению
  // (ts / ?) * ? = ?, которое индекс не покрывает, поэтому SQLite читал всю
  // таблицу целиком. Фронтенд опрашивает /api/candles раз в минуту, так что
  // 5 млн строк в сутки выжигались за считанные часы.
  //
  // Теперь open и close считаются оконными функциями в том же проходе:
  // ROW_NUMBER() нумерует сделки внутри бакета по возрастанию и по убыванию
  // времени, и первая строка каждой нумерации — это open и close.
  //
  // ПОЧЕМУ CAST(... AS INTEGER) ВОКРУГ БАКЕТА.
  //
  // Параметры приходят из JS как числа, и драйвер передаёт их в SQLite как
  // REAL. Для REAL деление не целочисленное: (1795710764 / 3600.0) * 3600.0
  // даёт 1795710764, а не 1795708800. Каждая сделка попадала в собственный
  // «бакет», и свечи не группировались: вместо одной часовой свечи с двумя
  // сделками приходило две свечи по одной. С целыми литералами (3600) SQLite
  // делит нацело, но с параметрами — уже нет, поэтому приводим явно.
  //
  // kind='swap' обязателен: flash-свопы дают нулевую/мусорную цену и не должны
  // попадать ни в OHLC, ни в объём.
  const { results } = await env.DB.prepare(
    `SELECT
       bucket,
       MIN(ts) AS ts,
       MIN(price) AS low,
       MAX(price) AS high,
       COUNT(*) AS trades,
       SUM(amount_in) AS volume,
       MIN(CASE WHEN rn_asc = 1 THEN price END)  AS open,
       MIN(CASE WHEN rn_desc = 1 THEN price END) AS close
     FROM (
       SELECT
         CAST(ts / CAST(? AS INTEGER) AS INTEGER) * CAST(? AS INTEGER) AS bucket,
         ts,
         CAST(price AS REAL)      AS price,
         CAST(amount_in AS REAL)  AS amount_in,
         ROW_NUMBER() OVER (
           PARTITION BY CAST(ts / CAST(? AS INTEGER) AS INTEGER) * CAST(? AS INTEGER)
           ORDER BY ts ASC, log_index ASC
         ) AS rn_asc,
         ROW_NUMBER() OVER (
           PARTITION BY CAST(ts / CAST(? AS INTEGER) AS INTEGER) * CAST(? AS INTEGER)
           ORDER BY ts DESC, log_index DESC
         ) AS rn_desc
       FROM trades
       WHERE pair = ?
         AND kind = 'swap'
         AND ts > (strftime('%s','now') - ?)
     )
     GROUP BY bucket
     ORDER BY bucket DESC
     LIMIT ?`
  )
    .bind(bucket, bucket, bucket, bucket, bucket, bucket, pair, bucket * limit, limit)
    .all()

  const candles = (results ?? []).map((r) => ({
    time: r.ts,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    trades: r.trades,
    volume: r.volume,
  }))

  return json({ pair, interval, candles })
}

async function handleTrades(url, env) {
  const pair = normPair(url.searchParams.get('pair'))
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

// ---------- шлюз для зеркала на IPFS ----------
//
// Отдаёт содержимое IPFS-каталога с нашего домена.
//
// Зачем это нужно. Публичные шлюзы для зеркала не годятся:
//
//   - gateway.pinata.cloud отдаёт 403 на HTML на бесплатном плане
//     («HTML content cannot be served through the pinata public gateway»);
//   - ipfs.io, dweb.link, w3s.link и nftstorage.link отвечают 429 либо
//     редиректят друг на друга, замыкаясь на ipfs.io;
//   - gateway.ipfs.io и nftstorage.link — 301/302 на ipfs.io, то есть тот же 429;
//   - cloudflare-ipfs.com закрыт, 4everland.io редиректит в мёртвый поддомен;
//   - ipfs.filebase.io работает, но у него СЛОМАН IPv6: AAAA-запись
//     2001:41d0:700:7828::1 не отвечает. Chrome по умолчанию идёт по IPv6
//     первым и получает ERR_CONNECTION_CLOSED, хотя curl с -4 отдаёт 200.
//
// Свой прокси решает всё сразу: домен наш, IPv4 и IPv6 у Cloudflare в порядке,
// лимитов публичных шлюзов нет.
//
// Что проксируем: только чтение по конкретному CID, без записи. Кеш ставим
// долгий — содержимое по CID неизменяемо, это адрес контента.
const MIRROR_CID = 'bafybeid6h7qzuvu2rkdmt7wrfyelpx7l2tz2mlq7x7e5z65pixmjgv7ycq'
const MIRROR_UPSTREAM = `https://ipfs.filebase.io/ipfs/${MIRROR_CID}`

async function handleMirror(request, url) {
  // Путь после /mirror/ — это путь внутри IPFS-каталога.
  let sub = url.pathname.replace(/^\/mirror\/?/, '')
  if (sub === '') sub = 'index.html'

  // Не выпускаем за пределы каталога и не даём подставить чужой CID.
  if (sub.includes('..')) return new Response('bad path', { status: 400 })

  const target = `${MIRROR_UPSTREAM}/${sub}`

  const upstream = await fetch(target, {
    method: request.method,
    headers: { accept: request.headers.get('accept') ?? '*/*' },
  })

  if (!upstream.ok) {
    return new Response(`upstream ${upstream.status}`, {
      status: upstream.status === 404 ? 404 : 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    })
  }

  // Тип берём у апстрима, но HTML и JS принудительно помечаем utf-8:
  // шлюз отдаёт text/html без кодировки, и кириллица ломалась бы.
  const type = upstream.headers.get('content-type') ?? 'application/octet-stream'
  const contentType = /^text\/|javascript|json/.test(type) && !/charset/i.test(type)
    ? `${type}; charset=utf-8`
    : type

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': contentType,
      // Содержимое по CID неизменяемо, поэтому кеш бессрочный.
      'cache-control': 'public, max-age=31536000, immutable',
      // Зеркало не должно встраиваться в чужие страницы.
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'access-control-allow-origin': '*',
    },
  })
}

async function handleStats(url, env) {
  const pair = normPair(url.searchParams.get('pair'))

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
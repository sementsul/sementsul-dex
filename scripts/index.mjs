#!/usr/bin/env node
// Индексатор сделок: сканирует блоки BSC и пишет их в D1.
//
// Почему это отдельный скрипт, а не Cloudflare Worker:
//
//   Поблочный обход через eth_getBlockReceipts съедает ~2 мс CPU на блок
//   (разбор всех логов блока, а их около 600 на блок). На Free-плане Workers
//   лимит CPU — единицы миллисекунд на вызов, поэтому воркер падал с
//   "Worker exceeded CPU time limit" уже на 1000 блоках. eth_getLogs, который
//   решил бы задачу одним запросом, из Workers недоступен: публичные BSC-RPC
//   троттлят общие egress-IP Cloudflare ("Rate limit exceeded").
//
//   GitHub Actions даёт обычный Node.js без лимитов CPU и субзапросов, поэтому
//   сканирование живёт здесь. Воркер остаётся только на чтение (свечи, сделки,
//   статистика) — это дешёвые запросы к D1.
//
// Запуск:
//   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... node scripts/index.mjs
//
// Переменные:
//   DAYS      — глубина индексации при первом запуске (по умолчанию 7)
//   MAX_BLOCKS — потолок блоков за один запуск (по умолчанию 40000)
//   PAIR      — адрес пары (по умолчанию SML/WBNB)

import { parseSwapV2, parseSwapV3 } from '../worker/logic.js'

// Пул по умолчанию — свой USDT/WBNB в V3. Раньше здесь стоял чужой пул
// SML/WBNB, к нашей бирже отношения не имеющий: история по нему накапливалась,
// но показывать её было негде.
//
// Адрес приводим к НИЖНЕМУ регистру. Раньше здесь стоял EIP-55-вид, и это
// сломало чтение: фронтенд берёт адрес из deployments.js, где контрольная
// сумма расставлена иначе (…D1e4… против …D1E4…). SQLite сравнивает TEXT
// побайтово, поэтому `pair = ?` не находил ни одной строки — API отдавал 200
// с пустым массивом. Подробности в worker/schema.sql и worker/index.js.
const PAIR = (
  process.env.PAIR ?? '0x37c7702B589c69D1E4f4ad32E19f372ED6780278'
).toLowerCase()
const DAYS = Number(process.env.DAYS ?? 7)
const MAX_BLOCKS = Number(process.env.MAX_BLOCKS ?? 40000)

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID
const TOKEN = process.env.CLOUDFLARE_API_TOKEN
const D1_NAME = process.env.D1_NAME ?? 'sementsul-dex'

const RPCS = [
  process.env.RPC_URL,
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
].filter(Boolean)

const BLOCKS_PER_DAY = 191574
const BATCH = 100

if (!ACCOUNT || !TOKEN) {
  console.error('нужны CLOUDFLARE_ACCOUNT_ID и CLOUDFLARE_API_TOKEN')
  process.exit(1)
}

// ---------- RPC ----------

let rpcUrl = null

async function jsonRpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  const j = await res.json()
  if (j.error) throw new Error(j.error.message)
  return j.result
}

// Повтор с нарастающей паузой: публичные RPC отвечают 429 при частых запросах.
async function withRetry(fn, label, attempts = 5) {
  let delay = 1000
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      const retryable =
        e.status === 429 ||
        e.status === 403 || // публичные RPC отдают 403 и при перегрузке
        e.status === 502 ||
        e.status === 503 ||
        /timeout|ECONN|fetch failed|rate limit|too many/i.test(e.message)
      if (!retryable || i === attempts) throw e
      console.log(`  ${label}: ${e.message}, повтор через ${delay} мс (${i}/${attempts})`)
      await new Promise((r) => setTimeout(r, delay))
      delay = Math.min(delay * 2, 15000)
    }
  }
}

// Выбираем первый живой RPC: пробуем eth_blockNumber.
async function pickRpc() {
  for (const url of RPCS) {
    try {
      const hex = await jsonRpc(url, 'eth_blockNumber', [])
      console.log(`RPC: ${url} (head ${Number(BigInt(hex))})`)
      return url
    } catch (e) {
      console.log(`RPC ${url} недоступен: ${e.message}`)
    }
  }
  throw new Error('ни один RPC не ответил')
}

async function latestBlock() {
  return Number(BigInt(await jsonRpc(rpcUrl, 'eth_blockNumber', [])))
}

// Пакетный запрос: несколько вызовов за один HTTP round-trip.
// Ответы сопоставляем по id — порядок не гарантирован.
async function rpcBatch(calls) {
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }))
  return withRetry(async () => {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    const arr = await res.json()
    if (!Array.isArray(arr)) throw new Error('ответ не массив')
    const byId = new Map(arr.map((x) => [x.id, x]))
    return calls.map((_, i) => {
      const item = byId.get(i + 1)
      return item && !item.error ? item.result : null
    })
  }, `batch ${calls.length}`)
}

// Логи пары за диапазон. Сначала пробуем eth_getLogs — один запрос на всё,
// что несравнимо быстрее обхода по блокам. Провайдеры ограничивают диапазон,
// поэтому крупные окна режем на куски.
//
// Лимит у publicnode — 10 000 блоков на запрос, и это проверено: 40 000
// отвечает «query exceeds max block range 10000», а 50 000 — «exceed maximum
// block range: 50000». Здесь стояло 45 000 — каждый запрос гарантированно
// падал, и скрипт молча уходил в обход по receipts, который на 20 000 блоков
// работает минутами и выглядит как зависание.
//
// Берём 9 000, с запасом: лимит может считаться включительно.
const GETLOGS_SPAN = 9000

async function logsViaGetLogs(fromBlock, toBlock) {
  const out = []
  for (let start = fromBlock; start <= toBlock; start += GETLOGS_SPAN) {
    const end = Math.min(start + GETLOGS_SPAN - 1, toBlock)
    try {
      const logs = await withRetry(
        () =>
          jsonRpc(rpcUrl, 'eth_getLogs', [
            {
              address: PAIR,
              fromBlock: '0x' + start.toString(16),
              toBlock: '0x' + end.toString(16),
            },
          ]),
        `getLogs ${start}..${end}`
      )
      if (!Array.isArray(logs)) return null
      out.push(...logs)
    } catch (e) {
      console.log(`  getLogs ${start}..${end} не сработал (${e.message.slice(0, 60)}) — иду по блокам`)
      return null
    }
    await new Promise((r) => setTimeout(r, 250)) // бережём лимит запросов
  }
  return out
}

// Обход по блокам через eth_getBlockReceipts: работает даже там, где getLogs
// забанен. Медленнее, но это надёжный путь.
async function logsViaReceipts(fromBlock, toBlock) {
  const logs = []
  const nums = []
  for (let n = fromBlock; n <= toBlock; n++) nums.push(n)

  for (let i = 0; i < nums.length; i += BATCH) {
    const slice = nums.slice(i, i + BATCH)
    const results = await rpcBatch(
      slice.map((n) => ({ method: 'eth_getBlockReceipts', params: ['0x' + n.toString(16)] }))
    )
    for (const receipts of results) {
      if (!Array.isArray(receipts)) continue
      for (const r of receipts) {
        for (const log of r?.logs ?? []) {
          if (log.address?.toLowerCase() === PAIR.toLowerCase()) logs.push(log)
        }
      }
    }
    if (i % (BATCH * 40) === 0 && i > 0) {
      console.log(`  ... ${i}/${nums.length} блоков, логов ${logs.length}`)
      await new Promise((r) => setTimeout(r, 300)) // не злим RPC
    }
  }
  return logs
}

// Узнаём, насколько глубоко провайдер отдаёт историю. Публичные узлы BSC
// архивными не являются: старые блоки отвечают 403 или «missing trie node»,
// и попытка их прочитать роняет весь запуск. Проверяем пробой, а не на веру.
async function findArchiveFloor(head) {
  const probe = async (n) => {
    if (n < 1) return false
    try {
      await jsonRpc(rpcUrl, 'eth_getBlockReceipts', ['0x' + n.toString(16)])
      return true
    } catch {
      return false
    }
  }

  // Шаг 1: убеждаемся, что сутки назад данные есть (это заведомо так).
  // Шаг 2: спускаемся назад удвоением, пока не наткнёмся на отказ.
  let ok = head - BLOCKS_PER_DAY
  if (!(await probe(ok))) return ok // даже сутки недоступны — работаем от head

  let bad = null
  for (let days = 2; days <= 100; days *= 2) {
    const n = head - days * BLOCKS_PER_DAY
    if (await probe(n)) ok = n
    else {
      bad = n
      break
    }
  }
  if (bad === null) return ok // глубже 100 дней проверять не стали

  // Шаг 3: между ok (доступен) и bad (нет) ищем границу делением пополам.
  for (let i = 0; i < 14 && ok - bad > 2000; i++) {
    const mid = Math.floor((ok + bad) / 2)
    if (await probe(mid)) ok = mid
    else bad = mid
  }
  return ok
}

// ---------- D1 ----------

const D1_BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database`

async function d1Query(dbId, sql, params = []) {
  const res = await fetch(`${D1_BASE}/${dbId}/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sql, params }),
  })
  const j = await res.json()
  if (!j.success) throw new Error(JSON.stringify(j.errors).slice(0, 300))
  return j.result
}

async function findDatabase() {
  const res = await fetch(`${D1_BASE}?name=${encodeURIComponent(D1_NAME)}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  })
  const j = await res.json()
  if (!j.success) throw new Error(JSON.stringify(j.errors).slice(0, 300))
  const hit = j.result?.find((d) => d.name === D1_NAME)
  if (!hit) throw new Error(`база ${D1_NAME} не найдена`)
  return hit.uuid
}

// Вставка пачкой: одна SQL-команда на много строк. D1 не любит по одному
// INSERT на запись, а мультистрочный VALUES укладывается в лимит запроса.
async function insertTrades(dbId, rows) {
  if (!rows.length) return 0
  const COLS = 11
  const CHUNK = Math.max(1, Math.floor(90 / COLS)) // ~8 строк на команду
  let inserted = 0

  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK)
    const placeholders = slice.map(() => `(${Array(COLS).fill('?').join(',')})`).join(',')
    const params = slice.flat()
    const sql = `INSERT OR IGNORE INTO trades
      (tx_hash, log_index, block, ts, pair, protocol, kind, zero_for_one, amount_in, amount_out, price)
      VALUES ${placeholders}`
    await d1Query(dbId, sql, params)
    inserted += slice.length
  }
  return inserted
}

// ---------- основной цикл ----------

async function main() {
  rpcUrl = await pickRpc()
  const dbId = await findDatabase()
  console.log(`D1: ${D1_NAME} (${dbId})`)

  const head = await latestBlock()

  // Продолжаем с последнего проиндексированного блока, иначе берём окно DAYS.
  // Важно не путать два ограничения: floor задаёт глубину (DAYS), а
  // MAX_BLOCKS — сколько блоков осилить за один запуск. Раньше здесь стоял
  // Math.max от обоих, из-за чего 365 дней молча превращались в 30.
  const last = await d1Query(dbId, 'SELECT last_block FROM sync_state WHERE pair = ?', [PAIR])
  const savedBlock = last?.[0]?.results?.[0]?.last_block ?? null

  // Насколько глубоко провайдер вообще отдаёт историю: за этот предел идти
  // бессмысленно, ответом будет 403.
  const archiveFloor = await findArchiveFloor(head)

  // Границы блоков обязаны быть целыми. DAYS можно задать дробным (0.1 дня),
  // и тогда head - DAYS * BLOCKS_PER_DAY даёт 135791217.6 — такой номер не
  // существует, и eth_getLogs отвечает «Invalid params». Скрипт после этого
  // молча уходил в обход по receipts, то есть в минуты ожидания вместо
  // одного запроса.
  const deepest = Math.max(Math.floor(archiveFloor), Math.ceil(head - DAYS * BLOCKS_PER_DAY))
  console.log(
    `глубина: запрошено ${DAYS} дн., доступно ${Math.round((head - archiveFloor) / BLOCKS_PER_DAY)} дн.`
  )

  let fromRaw
  if (savedBlock && savedBlock > deepest && savedBlock < head) {
    fromRaw = savedBlock + 1 // продолжаем с места остановки
  } else if (savedBlock && savedBlock >= head - 5) {
    console.log('новых блоков нет')
    return
  } else {
    fromRaw = deepest // начинаем с самой глубокой доступной точки
  }

  // Ограничение по объёму за запуск: идём от старых блоков к новым.
  const from = Math.ceil(fromRaw)
  const to = Math.floor(Math.min(from + MAX_BLOCKS - 1, head))
  console.log(`блоки ${from}..${to} (${to - from + 1}), глубина ${DAYS} дн.`)
  const t0 = Date.now()

  let logs = await logsViaGetLogs(from, to)
  if (!logs) logs = await logsViaReceipts(from, to)

  // Разбор отсеивает всё, кроме Swap: blockReceipts отдаёт события всех
  // контрактов, а getLogs — только нужного адреса, но и там бывают Sync/Transfer.
  //
  // Пулов два типа, и события у них разные: у пары V2 — Swap с четырьмя
  // суммами в data, у пула V3 — Swap с суммой, ценой и тиком. Пробуем оба
  // разбора подряд: адрес в PAIR один, поэтому лишнего не найдётся, а
  // поддерживать два кодовых пути для V2 и V3 не нужно.
  const parseAny = (log) => parseSwapV2(log) ?? parseSwapV3(log)

  const parsed = []
  const blockTimes = new Map()
  const blockNums = [...new Set(logs.filter((l) => parseAny(l)).map((l) => l.blockNumber))]

  for (let i = 0; i < blockNums.length; i += BATCH) {
    const slice = blockNums.slice(i, i + BATCH)
    const blocks = await rpcBatch(
      slice.map((bn) => ({ method: 'eth_getBlockByNumber', params: [bn, false] }))
    )
    for (let k = 0; k < blocks.length; k++) {
      if (blocks[k]?.timestamp) blockTimes.set(slice[k], Number(BigInt(blocks[k].timestamp)))
    }
  }

  for (const log of logs) {
    const p = parseAny(log)
    if (!p) continue
    parsed.push([
      log.transactionHash,
      Number(BigInt(log.logIndex)),
      Number(BigInt(log.blockNumber)),
      blockTimes.get(log.blockNumber) ?? 0,
      PAIR,
      p.protocol,
      p.kind,
      p.zeroForOne ? 1 : 0,
      p.amountIn.toString(),
      p.amountOut.toString(),
      p.price.toString(),
    ])
  }

  console.log(`логов ${logs.length}, сделок ${parsed.length}`)
  const inserted = await insertTrades(dbId, parsed)

  // Запоминаем прогресс: иначе следующий запуск начнёт заново.
  // Пишем в sync_state (pair, last_block, updated_at) — именно эту таблицу
  // читает воркер, и она же служит курсором для следующего запуска.
  await d1Query(
    dbId,
    `INSERT INTO sync_state (pair, last_block, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(pair) DO UPDATE SET last_block = excluded.last_block, updated_at = excluded.updated_at`,
    [PAIR, to, Math.floor(Date.now() / 1000)]
  )

  console.log(
    `готово: вставлено ${inserted}, ${((Date.now() - t0) / 1000).toFixed(1)} с`
  )
}

main().catch((e) => {
  console.error('ошибка:', e.message)
  process.exit(1)
})
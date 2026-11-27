// Клиент к воркеру-индексатору: последние сделки и статистика пула.
//
// Воркер нужен потому, что eth_getLogs заблокирован на обоих RPC. Если воркер
// недоступен (не задеплоен, лежит), интерфейс не должен падать — история просто
// не показывается, обмен продолжает работать.

// Свой поддомен вместо workers.dev.
//
// Раньше здесь стоял адрес вида sementsul-dex-api.<аккаунт>.workers.dev. Он
// работал, но в интерфейсе биржи это выглядело как временное решение: чужой
// служебный поддомен в запросах к API. Плюс на workers.dev нельзя поставить
// свои правила кеширования и WAF.
//
// Теперь воркер привязан к api.sementsul.net через Workers Domains: Cloudflare
// сам создал DNS-запись и выпустил сертификат.
//
// VITE_API_BASE остаётся для локальной разработки: можно поднять воркер
// через `npm run worker:dev` и направить фронтенд на 127.0.0.1.
const API_BASE = import.meta.env.VITE_API_BASE ?? 'https://api.sementsul.net'

const TIMEOUT_MS = 6000

async function apiFetch(path) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    // cache: 'no-store' — не отдавать ответ из HTTP-кеша браузера.
    //
    // Без этого «Последние сделки» показывали данные 19-часовой давности,
    // хотя API отдавал свежие: браузер держал ответ по Cache-Control. Здесь
    // история меняется постоянно, и любой кеш на стороне клиента — это
    // устаревшая информация на экране. Кешировать должен только воркер.
    const res = await fetch(API_BASE + path, { signal: ctrl.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchRecentTrades(pair, limit = 8) {
  const data = await apiFetch(`/api/trades?pair=${pair}&limit=${limit}`)
  return (data?.trades ?? []).map((t) => ({
    txHash: t.tx_hash,
    block: t.block,
    ts: t.ts,
    protocol: t.protocol,
    // price лежит строкой в масштабе 1e18
    price: Number(t.price) / 1e18,
    amountIn: t.amount_in,
    amountOut: t.amount_out,
    zeroForOne: t.zero_for_one === 1,
  }))
}

export async function fetchPoolStats(pair) {
  const data = await apiFetch(`/api/stats?pair=${pair}`)
  return {
    lastPrice: data?.lastPrice ? Number(data.lastPrice) / 1e18 : null,
    lastTradeTs: data?.lastTradeTs ?? null,
    dayTrades: data?.day?.trades ?? 0,
    totalTrades: data?.totalTrades ?? 0,
  }
}

export async function fetchCandles(pair, interval = '1h', limit = 48) {
  const data = await apiFetch(`/api/candles?pair=${pair}&interval=${interval}&limit=${limit}`)
  return data?.candles ?? []
}

// Проверка доступности: если воркер не задеплоен, не дёргаем его на каждом рендере.
let healthCache = { ok: null, at: 0 }
export async function isIndexerAvailable() {
  const now = Date.now()
  if (healthCache.ok !== null && now - healthCache.at < 60_000) return healthCache.ok
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 3000)
    const res = await fetch(API_BASE + '/api/health', { signal: ctrl.signal })
    clearTimeout(timer)
    healthCache = { ok: res.ok, at: now }
    return res.ok
  } catch {
    healthCache = { ok: false, at: now }
    return false
  }
}
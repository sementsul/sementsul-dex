// RPC-транспорт для on-chain сборки.
//
// Задача: работать без своего сервера и без CORS-прокси. Поэтому шлём
// обычный POST на публичные BSC-узлы. Все проверенные ниже отдают
// Access-Control-Allow-Origin: *, иначе браузер заблокировал бы ответ.
//
// Порядок важен: первый узел — самый быстрый в наших замерах, но если он
// недоступен, переходим к следующему. Массив именно массив, а не строка:
// единственный адрес означал бы единственную точку отказа.

const NODES = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-rpc.publicnode.com',
  'https://1rpc.io/bnb',
  'https://bsc.drpc.org',
]

let nodeIndex = 0
let reqId = 1
const TIMEOUT_MS = 15000

async function post(url, body) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// Одиночный вызов с перебором узлов.
export async function rpc(method, params) {
  let lastErr = null
  for (let attempt = 0; attempt < NODES.length; attempt++) {
    const url = NODES[(nodeIndex + attempt) % NODES.length]
    try {
      const out = await post(url, { jsonrpc: '2.0', method, params, id: reqId++ })
      if (out.error) throw new Error(out.error.message ?? 'rpc error')
      nodeIndex = (nodeIndex + attempt) % NODES.length
      return out.result
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('все узлы недоступны')
}

// Пакетный вызов. BSC-узлы принимают массивы; порядок ответов не гарантирован,
// поэтому сопоставляем по id, а не по индексу. Это уже ловило реальный баг:
// узлы возвращали результаты вперемешку, и балансы приписывались не тем токенам.
export async function batch(calls) {
  if (!calls.length) return []
  if (calls.length === 1) return [await rpc(calls[0].method ?? 'eth_call', calls[0].params ?? [calls[0], 'latest'])]

  const CHUNK = 60
  const out = []
  for (let i = 0; i < calls.length; i += CHUNK) {
    const slice = calls.slice(i, i + CHUNK)
    const payload = slice.map((c, j) => ({
      jsonrpc: '2.0',
      id: i + j,
      method: c.method ?? 'eth_call',
      params: c.params ?? [c, 'latest'],
    }))

    let res = null
    for (let attempt = 0; attempt < NODES.length && !res; attempt++) {
      const url = NODES[(nodeIndex + attempt) % NODES.length]
      try {
        res = await post(url, payload)
        if (!Array.isArray(res)) res = null
      } catch {
        res = null
      }
    }
    if (!res) throw new Error('все узлы недоступны')

    const byId = new Map()
    for (const r of res) byId.set(r.id, r)
    for (let j = 0; j < slice.length; j++) {
      const r = byId.get(i + j)
      if (!r || r.error) out.push(null)
      else out.push(r.result)
    }
  }
  return out
}

// eth_call по одному адресу
export function call(to, data) {
  return { to, data }
}

export async function callOne(to, data) {
  const [r] = await batch([{ to, data }])
  return r
}

// Читает все eth_call'ы и возвращает результаты в том же порядке
export async function callMany(list) {
  return batch(list)
}

export const RPC_NODES = NODES
// Транспорт к BSC.
//
// Ключевой факт, проверенный на цепи: MEV Guard принимает батч из 100 eth_call,
// официальный bsc-dataseed упирается в лимит уже на 40 ("method eth_call in batch
// triggered rate limit"). Поэтому батчим только на MEV Guard, а фолбэк используем
// для одиночных вызовов и как резерв при отказе.
//
// ВАЖНО: порядок элементов в ответе на батч НЕ гарантирован (проверено: id приходят
// переставленными). Всегда сопоставляем по id, а не по индексу.

import { RPC_PRIVATE, RPC_FALLBACK } from './chain.js'

const MAX_BATCH = 100
const TIMEOUT_MS = 20000

class RpcError extends Error {
  constructor(message, code, data) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }
}

async function postRaw(url, payload, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  if (!res.ok) throw new RpcError(`HTTP ${res.status} от ${new URL(url).host}`, res.status)
  return res.json()
}

function withTimeout(ms) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), ms)
  return { signal: ctrl.signal, done: () => clearTimeout(t) }
}

// Одиночный вызов с фолбэком по списку эндпоинтов.
export async function rpc(method, params, { endpoints = [RPC_PRIVATE, RPC_FALLBACK] } = {}) {
  let lastErr
  for (const url of endpoints) {
    const { signal, done } = withTimeout(TIMEOUT_MS)
    try {
      const json = await postRaw(url, { jsonrpc: '2.0', id: 1, method, params }, signal)
      if (json.error) throw new RpcError(json.error.message, json.error.code, json.error.data)
      return json.result
    } catch (e) {
      lastErr = e
    } finally {
      done()
    }
  }
  throw lastErr ?? new RpcError('Все RPC недоступны')
}

// Батч eth_call. Принимает [{to, data, blockTag?}], возвращает массив результатов
// в ТОМ ЖЕ порядке, что и вход. Ошибка отдельного вызова даёт null в его позиции,
// а не роняет весь батч.
export async function batchCall(calls, { blockTag = 'latest', endpoint = RPC_PRIVATE } = {}) {
  const out = new Array(calls.length).fill(null)
  if (calls.length === 0) return out

  const chunks = []
  for (let i = 0; i < calls.length; i += MAX_BATCH) {
    chunks.push(calls.slice(i, i + MAX_BATCH))
  }

  let baseId = 1
  for (const chunk of chunks) {
    const ids = []
    const payload = chunk.map((c, i) => {
      const id = baseId + i
      ids.push(id)
      return {
        jsonrpc: '2.0',
        id,
        method: 'eth_call',
        params: [{ to: c.to, data: c.data }, c.blockTag ?? blockTag],
      }
    })
    const offset = baseId - 1
    baseId += chunk.length

    const { signal, done } = withTimeout(TIMEOUT_MS)
    let json
    try {
      json = await postRaw(endpoint, payload, signal)
    } catch (e) {
      // Батч не прошёл целиком — добиваем одиночными через фолбэк.
      for (let i = 0; i < chunk.length; i++) {
        try {
          out[offset + i] = await rpc('eth_call', [{ to: chunk[i].to, data: chunk[i].data }, blockTag], {
            endpoints: [RPC_FALLBACK, RPC_PRIVATE],
          })
        } catch {
          out[offset + i] = null
        }
      }
      done()
      continue
    } finally {
      done()
    }

    if (!Array.isArray(json)) {
      // Эндпоинт ответил объектом (например, общей ошибкой) — деградируем.
      const msg = json?.error?.message ?? 'Некорректный ответ на батч'
      throw new RpcError(msg, json?.error?.code)
    }

    for (const item of json) {
      const idx = item.id - offset - 1
      if (idx >= 0 && idx < chunk.length) {
        out[offset + idx] = item.error ? null : item.result
      }
    }
  }
  return out
}

// eth_call с фолбэком на официальный RPC, если приватный вернул null.
export async function call(to, data, blockTag = 'latest') {
  const r = await rpc('eth_call', [{ to, data }, blockTag], { endpoints: [RPC_PRIVATE] }).catch(() => null)
  if (r !== null) return r
  return rpc('eth_call', [{ to, data }, blockTag], { endpoints: [RPC_FALLBACK] })
}

export { RpcError }
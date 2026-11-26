// Сквозная проверка комплаенса в браузерном окружении.
//
// Проверяем не только чистые функции (это делает test-compliance.mjs), но и:
//   · загрузку списка санкций по HTTP из реального dist;
//   · срабатывание гейта в sendTransaction — то есть что блокировку нельзя
//     обойти, вызвав обработчик напрямую;
//   · что гео-эндпоинт отдаёт корректный JSON и не кэшируется.
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'

const DIST = 'dist'
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
}

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) {
    passed++
    console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`  ФЕЙЛ ${name}${extra ? '  ' + extra : ''}`)
  }
}

// ---------- статический сервер поверх dist ----------
const server = createServer((req, res) => {
  const path = req.url.split('?')[0]
  const file = join(DIST, path === '/' ? 'index.html' : path)
  if (existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
    return
  }
  res.writeHead(404)
  res.end('not found')
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

console.log(`\n=== файлы в dist ===`)
check('список санкций собран в dist', existsSync(join(DIST, 'sanctions/ofac-addresses.json')))
check('_routes.json собран в dist', existsSync(join(DIST, '_routes.json')))
check('_headers собран в dist', existsSync(join(DIST, '_headers')))

console.log('\n=== список отдаётся по HTTP ===')
const res = await fetch(`${base}/sanctions/ofac-addresses.json`)
check('статус 200', res.status === 200)
const data = await res.json()
check('адреса есть', Object.keys(data.addresses).length > 100, `${Object.keys(data.addresses).length}`)

console.log('\n=== _routes.json ограничивает Functions ===')
const routes = JSON.parse(readFileSync(join(DIST, '_routes.json'), 'utf8'))
check('include содержит /api/*', routes.include.includes('/api/*'))
check(
  'exclude не глушит /api/geo',
  !routes.exclude.some((r) => r === '/*' || r.startsWith('/api'))
)
check(
  'статике Functions не нужны (include узкий)',
  !routes.include.includes('/*')
)

console.log('\n=== гейт в sendTransaction ===')

// Эмулируем окружение кошелька: window.ethereum, который считает вызовы.
let ethCalls = 0
globalThis.window = {
  ethereum: {
    request: async ({ method }) => {
      ethCalls++
      if (method === 'eth_accounts') return ['0x1111111111111111111111111111111111111111']
      if (method === 'eth_chainId') return '0x38'
      if (method === 'eth_sendTransaction') return '0xdeadbeef'
      if (method === 'eth_estimateGas') return '0x5208'
      return null
    },
  },
}
globalThis.localStorage = {
  store: new Map(),
  getItem(k) { return this.store.get(k) ?? null },
  setItem(k, v) { this.store.set(k, v) },
  removeItem(k) { this.store.delete(k) },
}

const { sendTransaction, setComplianceGate } = await import('../src/lib/wallet.js')

// Без гейта транзакция проходит.
ethCalls = 0
const hash = await sendTransaction({ to: '0x2222222222222222222222222222222222222222', data: '0x' })
check('без гейта транзакция уходит', hash === '0xdeadbeef')
check('кошелёк был вызван', ethCalls > 0)

// С гейтом — отказ, и кошелёк не тревожится.
setComplianceGate(() => {
  throw new Error('Доступ ограничен')
})
ethCalls = 0
let blocked = false
let message = ''
try {
  await sendTransaction({ to: '0x2222222222222222222222222222222222222222', data: '0x' })
} catch (e) {
  blocked = true
  message = e.message
}
check('с гейтом транзакция блокируется', blocked)
check('сообщение проброшено', message === 'Доступ ограничен')
check('кошелёк НЕ вызывался при блокировке', ethCalls === 0)

// Снятие гейта возвращает работоспособность.
setComplianceGate(null)
ethCalls = 0
const hash2 = await sendTransaction({ to: '0x2222222222222222222222222222222222222222', data: '0x' })
check('после снятия гейта транзакция снова проходит', hash2 === '0xdeadbeef')

console.log('\n=== проверка адреса по списку ===')

// Подменяем fetch так, чтобы compliance.js читал локальный файл.
const realFetch = globalThis.fetch
globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/sanctions/ofac-addresses.json')) {
    return realFetch(`${base}/sanctions/ofac-addresses.json`, opts)
  }
  return realFetch(url, opts)
}

const { checkAddress, loadSanctions, evaluateGeo } = await import('../src/lib/compliance.js')

const clean = await checkAddress('0x1111111111111111111111111111111111111111')
check('чистый адрес не в списке', clean.listed === false)
check('список при этом доступен', clean.unavailable === false)

// Реальный адрес из списка OFAC (Lazarus Group).
const listed = await checkAddress('0x098b716b8aaf21512996dc57eb0615e2383e2f96')
check('адрес Lazarus найден в списке', listed.listed === true)
check('вернулись имена', (listed.entry?.names ?? []).some((n) => /LAZARUS/i.test(n)))
check('вернулись программы', (listed.entry?.programs ?? []).length > 0)

// Регистр не должен иметь значения.
const upper = await checkAddress('0x098B716B8AAF21512996DC57EB0615E2383E2F96')
check('регистр адреса не важен', upper.listed === true)

// Мусор вместо адреса.
const junk = await checkAddress('не адрес')
check('мусорный ввод не в списке', junk.listed === false)

// Список закэширован: повторный вызов не должен ходить в сеть.
const again = await loadSanctions()
check('список кэшируется в памяти', again !== null && again.set.size > 100)

globalThis.fetch = realFetch

console.log('\n=== гео-решение по реальному ответу ===')
const nl = evaluateGeo({ country: 'NL', region: 'North Holland' })
check('Нидерланды не блокируются', nl.blocked === false)
const ir = evaluateGeo({ country: 'IR' })
check('Иран блокируется', ir.blocked === true)

server.close()
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
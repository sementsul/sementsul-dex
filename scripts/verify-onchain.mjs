// Проверка, что опубликованный интерфейс реально читается из блокчейна.
//
// Идея чтения: eth_getTransactionByHash отдаёт input транзакции как есть.
// Дальше этот input можно показать как HTML. Никакого IPFS, домена или
// нашего API в цепочке нет.
// Хеш транзакции передаётся аргументом: при каждой публикации он новый,
// и зашитый в код старый хеш проверял бы уже не то, что лежит на сайте.
const TX = process.argv[2] ?? '0x806dd483c3dfbe955794d3f830c0d05a4d287973ae6774e7a21b6d8243970fd0'
const NODES = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-rpc.publicnode.com',
  'https://1rpc.io/bnb',
  'https://bsc.drpc.org',
]

const rpc = async (url, method, params) => {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  })
  return r.json()
}

;(async () => {
  console.log('=== чтение из блокчейна ===')
  let html = null
  for (const url of NODES) {
    const t0 = Date.now()
    try {
      const r = await rpc(url, 'eth_getTransactionByHash', [TX])
      const ms = Date.now() - t0
      if (r.error) {
        console.log(`  [ОШИБКА] ${new URL(url).host}: ${r.error.message}`)
        continue
      }
      const inp = r.result.input
      const bytes = (inp.length - 2) / 2
      console.log(`  [OK] ${new URL(url).host}: ${bytes} байт за ${ms} мс`)
      if (!html) html = inp
    } catch (e) {
      console.log(`  [СЕТЬ] ${new URL(url).host}: ${e.message}`)
    }
  }

  if (!html) {
    console.log('\n  не удалось прочитать')
    process.exit(1)
  }

  const text = Buffer.from(html.slice(2), 'hex').toString('utf8')
  console.log('\n=== содержимое ===')
  console.log('  начинается с:', JSON.stringify(text.slice(0, 60)))
  console.log('  заканчивается:', JSON.stringify(text.slice(-40)))
  console.log('  это HTML?', text.trimStart().startsWith('<!DOCTYPE html>'))
  console.log('  есть <script>?', text.includes('<script>'))
  console.log('  есть start()?', text.includes('__mod_app_js.start()'))
  console.log('  размер:', text.length, 'символов')

  // Проверим, что внутри нет обрезанных конструкций
  console.log('\n=== проверка целостности ===')
  const openScript = (text.match(/<script>/g) || []).length
  const closeScript = (text.match(/<\/script>/g) || []).length
  console.log('  <script>:', openScript, ' </script>:', closeScript, openScript === closeScript ? 'сбалансированы' : 'НЕ СБАЛАНСИРОВАНЫ')

  // Ключевые функции на месте
  for (const fn of ['discoverPools', 'findBestRoute', 'buildSwap', 'buildMintV3', 'positionKey', 'keccak256']) {
    console.log(`  ${fn}:`, text.includes(fn) ? 'есть' : 'НЕТ')
  }
})().catch((e) => console.error('ошибка:', e.message))
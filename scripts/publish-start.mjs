// Кладёт стартовую страницу в public/ как /chain — чтобы её мог открыть кто угодно.
//
// Почему именно так. Шлюзы вроде w3link читают КОД контракта (eth_getCode),
// а наш интерфейс лежит в calldata транзакции. Значит шлюз его не увидит
// никогда, сколько бы мы ни платили за хранение. Нужна тонкая прослойка,
// которая сама прочитает input транзакции.
//
// Эта прослойка — статический HTML на 6 KB. Он не ходит никуда, кроме
// публичных RPC, и его можно скачать, положить на флешку и открыть
// локально: работать будет так же. Сам интерфейс (80 KB) живёт в цепи.
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'

const SRC = 'dist-onchain/start.html'
const DEST = 'public/chain/index.html'

if (!existsSync(SRC)) {
  console.error('нет', SRC, '— сначала: node scripts/build-start.mjs')
  process.exit(1)
}

mkdirSync('public/chain', { recursive: true })
copyFileSync(SRC, DEST)

const bytes = readFileSync(DEST).length
console.log('  скопировано:', DEST)
console.log('  размер:', bytes, 'байт')
console.log('\n  после сборки сайта откроется как /chain')

// Проверим _routes.json: /chain не должен уходить в Functions.
if (existsSync('public/_routes.json')) {
  const r = JSON.parse(readFileSync('public/_routes.json', 'utf8'))
  console.log('\n=== маршруты ===')
  console.log('  include:', JSON.stringify(r.include))
  console.log('  exclude:', JSON.stringify(r.exclude))
  console.log('  /chain обслуживается статикой:', !r.include.some((p) => p.startsWith('/chain')) ? 'да' : 'НЕТ')
}
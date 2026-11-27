#!/usr/bin/env node
// Проверки зеркала для IPFS.
//
// Тест статический: он читает исходники и не требует сети. Задача — не
// допустить, чтобы перенос на IPFS сломался незаметно. Абсолютный путь к
// статике не виден на Cloudflare Pages (там сайт в корне домена), но на шлюзе
// ломает загрузку целиком.

import { readFileSync, existsSync } from 'node:fs'

let passed = 0
let failed = 0

function check(ok, label, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function read(path) {
  return readFileSync(path, 'utf8')
}

const vite = read('vite.config.js')
const app = read('src/App.jsx')
const compliance = read('src/lib/compliance.js')
const useCompliance = read('src/lib/useCompliance.js')
const indexer = read('src/lib/indexer.js')
const i18n = read('src/lib/i18n.js')
const pkg = JSON.parse(read('package.json'))

console.log('\n=== сборка зеркала ===\n')

check(
  /process\.env\.MIRROR/.test(vite),
  'vite.config.js переключает базу через MIRROR'
)
check(
  /base:\s*MIRROR\s*\?\s*'\.\/'\s*:\s*'\/'/.test(vite),
  'при MIRROR=1 база относительная, иначе корень домена'
)
check(
  /outDir:\s*MIRROR\s*\?\s*'dist-mirror'\s*:\s*'dist'/.test(vite),
  'сборка зеркала идёт в отдельный каталог'
)
check(
  Boolean(pkg.scripts?.['build:mirror']),
  'есть npm run build:mirror'
)

console.log('\n=== относительные пути ===\n')

// Логотип: абсолютный '/sml-256.png' на IPFS уводит в корень шлюза.
check(
  !/src="\/sml-\d+\.png"/.test(app),
  'логотип не используется по абсолютному пути'
)
check(
  /BASE_URL/.test(app),
  'логотип берётся через BASE_URL'
)

// Санкционный список: абсолютный путь ломает OFAC-скрининг на зеркале.
check(
  !/fetch\(\s*'\/sanctions\//.test(compliance),
  'санкционный список не запрашивается по абсолютному пути'
)
// Путь собирается через BASE_URL. Допускаем обе формы: прямое обращение и
// через локальную переменную BASE — вторая нужна, потому что модуль импортируют
// тесты в обычном Node, где import.meta.env отсутствует.
check(
  /BASE_URL[\s\S]{0,80}sanctions\/ofac-addresses\.json/.test(compliance),
  'путь к санкционному списку собран через BASE_URL'
)
check(
  !/import\.meta\.env\.BASE_URL/.test(compliance),
  'обращение к BASE_URL защищено от отсутствия import.meta.env (тесты в Node)'
)

// Адрес API обязан быть абсолютным: он единственный источник данных, который
// должен пережить перенос на IPFS.
check(
  /https:\/\/api\.sementsul\.net/.test(indexer),
  'адрес API абсолютный'
)

console.log('\n=== честность гео-проверки ===\n')

// Главное: отказ гео-эндпоинта не должен выглядеть как «проверено и чисто».
check(
  /status:\s*'unavailable'/.test(useCompliance),
  'недоступность гео — отдельное состояние, а не null'
)
check(
  /geoUnavailable/.test(useCompliance),
  'состояние geoUnavailable возвращается наружу'
)
check(
  !/if \(!res\.ok\) return null/.test(useCompliance),
  'нет молчаливого возврата null при отказе эндпоинта'
)

// Запрос гео остаётся относительным осознанно: его провал и включает плашку.
check(
  /fetch\('\/api\/geo'/.test(useCompliance),
  '/api/geo запрашивается относительно (его провал включает плашку)'
)

// Плашка должна быть видна в разметке и переведена на оба языка.
check(
  /compliance\.geoUnavailable/.test(app),
  'плашка о недоступной проверке выведена в интерфейсе'
)
const ruBlock = i18n.slice(0, i18n.indexOf("'compliance.actionsBlocked'"))
check(
  /'compliance\.geoUnavailable'/.test(ruBlock),
  'текст плашки есть в русском словаре'
)
const enStart = i18n.lastIndexOf("'compliance.sanctionsUnavailable'")
check(
  /'compliance\.geoUnavailable'/.test(i18n.slice(enStart)),
  'текст плашки есть в английском словаре'
)

console.log('\n=== прокси-шлюз в воркере ===\n')

// Публичные шлюзы для зеркала не годятся: Pinata отдаёт 403 на HTML, ipfs.io и
// его зеркала — 429, у Filebase сломан IPv6 (Chrome идёт по нему первым и
// получает ERR_CONNECTION_CLOSED). Поэтому зеркало раздаёт свой воркер.
// Проверки ниже стерегут, чтобы этот маршрут не пропал.
const worker = read('worker/index.js')

check(
  /MIRROR_CID\s*=\s*'bafy[a-z0-9]+'/.test(worker),
  'в воркере закреплён CID зеркала'
)
check(
  /url\.pathname\.startsWith\('\/mirror\/'\)/.test(worker),
  'воркер обрабатывает префикс /mirror/'
)
check(
  /sub\.includes\('\.\.'\)/.test(worker),
  'прокси не выпускает за пределы каталога'
)
check(
  /max-age=31536000, immutable/.test(worker),
  'у зеркала бессрочный кеш: содержимое по CID неизменяемо'
)

console.log('\n=== документация ===\n')

check(existsSync('docs/IPFS-MIRROR.md'), 'есть docs/IPFS-MIRROR.md')
const doc = read('docs/IPFS-MIRROR.md')
check(
  /build:mirror/.test(doc),
  'в документе описан способ сборки'
)
check(
  /serve-mirror\.mjs/.test(doc),
  'в документе описан локальный просмотр'
)
check(
  /DNSLink/.test(doc) && /403/.test(doc),
  'зафиксировано, что DNSLink на проверенных шлюзах не работает'
)
check(
  /не работает/.test(doc),
  'сказано прямо, что санкционный барьер на зеркале не работает'
)

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
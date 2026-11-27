#!/usr/bin/env node
// Сборка зеркала для IPFS.
//
// Отличие от обычной сборки — в базовом пути. На Cloudflare Pages сайт лежит в
// корне домена, и '/assets/…' работает. На IPFS корня домена нет: контент
// адресуется по CID и может отдаваться как /ipfs/<CID>/…, поэтому абсолютный
// путь уводит в никуда — страница открывается, но без стилей и скриптов.
//
// Второе отличие — серверной части. На IPFS нет Cloudflare Pages Functions,
// поэтому /api/geo недоступен. Интерфейс это распознаёт и показывает плашку
// (см. compliance.geoUnavailable), а данные индексатора берутся с
// api.sementsul.net: этот адрес абсолютный и переживает перенос на IPFS.
//
// Скрипт не просто собирает, а проверяет результат: битую копию лучше поймать
// здесь, чем после загрузки на шлюз.

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'dist-mirror'
let failed = 0

function check(ok, label, detail = '') {
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

console.log('\n=== сборка зеркала ===\n')

// Запускаем vite через его точку входа, а не через npx.
//
// npx на Windows требует shell: true, а это тянет DeprecationWarning и лишний
// слой интерпретации командной строки. Прямой вызов bin-скрипта обходит и то,
// и другое.
const viteBin = join('node_modules', 'vite', 'bin', 'vite.js')
execFileSync(process.execPath, [viteBin, 'build'], {
  env: { ...process.env, MIRROR: '1' },
  stdio: 'inherit',
})

console.log('\n=== проверки ===\n')

const html = readFileSync(join(OUT, 'index.html'), 'utf8')

// 1. Все ссылки на свои ресурсы должны быть относительными.
const localRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !/^(https?:)?\/\//.test(u) && !u.startsWith('data:'))

check(localRefs.length > 0, 'в index.html есть ссылки на ресурсы')
check(
  localRefs.every((u) => u.startsWith('./') || u.startsWith('../')),
  'все локальные ссылки относительные',
  localRefs.filter((u) => !u.startsWith('./') && !u.startsWith('../')).join(', ')
)

// 2. Сборка не должна тянуть ресурсы из корня домена.
const rootAbsolute = localRefs.filter((u) => u.startsWith('/'))
check(rootAbsolute.length === 0, 'нет ссылок от корня домена', rootAbsolute.join(', '))

// 3. Санкционный список обязан попасть в сборку: иначе на зеркале молча
//    перестанет работать проверка адреса.
let sanctionsOk = false
try {
  const s = JSON.parse(readFileSync(join(OUT, 'sanctions/ofac-addresses.json'), 'utf8'))
  sanctionsOk = Boolean(s?.addresses) && Object.keys(s.addresses).length > 0
} catch {
  sanctionsOk = false
}
check(sanctionsOk, 'санкционный список попал в сборку и не пуст')

// 4. В JS не должно остаться абсолютных путей к статике. Обращения к API
//    проверяем отдельно: они допустимы, но только через https://api.…
const jsFiles = walk(join(OUT, 'assets')).filter((f) => f.endsWith('.js'))
const jsSources = jsFiles.map((f) => readFileSync(f, 'utf8')).join('\n')

check(
  !/["'`]\/sanctions\//.test(jsSources),
  'нет абсолютного пути к санкционному списку'
)
check(
  !/["'`]\/sml-\d+\.png/.test(jsSources),
  'нет абсолютного пути к логотипу'
)
check(
  jsSources.includes('https://api.sementsul.net'),
  'адрес API абсолютный — данные индексатора переживут перенос'
)

// 5. Гео-запрос обязан остаться относительным: именно его провал на IPFS
//    включает честную плашку вместо молчаливого пропуска.
check(
  /["'`]\/api\/geo["'`]/.test(jsSources),
  'запрос /api/geo относительный (на IPFS его отсутствие включает плашку)'
)

console.log('')
if (failed > 0) {
  console.error(`зеркало не собрано: ${failed} проверок упало\n`)
  process.exit(1)
}

console.log(`Зеркало готово: ${OUT}/`)
console.log('Загрузить на IPFS: см. docs/IPFS-MIRROR.md\n')
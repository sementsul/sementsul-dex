// Проверка синтаксиса _headers и _redirects — ровно те правила, что применяет
// Cloudflare Pages. Запуск: node verify-headers.mjs
//
// Зачем: строка без '#' внутри блока трактуется как заголовок. Русский
// комментарий без решётки ломает разбор всего файла, и сайт теряет CSP —
// при этом сборка и деплой проходят успешно, то есть ошибка невидима.

import { readFileSync, existsSync } from 'node:fs'

let pass = 0
let fail = 0
function check(label, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`OK   ${label} ${extra}`)
  } else {
    fail++
    console.log(`FAIL ${label} ${extra}`)
  }
}

// ---------- _headers ----------

function validateHeaders(text) {
  const errors = []
  let lastWasPath = false
  let rules = 0
  let headers = 0
  const lines = text.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed) {
      lastWasPath = false
      continue
    }
    if (trimmed.startsWith('#')) continue

    const indented = /^\s/.test(raw)
    if (!indented) {
      if (!trimmed.startsWith('/')) {
        errors.push(`строка ${i + 1}: путь должен начинаться с / -> "${trimmed.slice(0, 70)}"`)
      } else {
        rules++
        lastWasPath = true
      }
    } else {
      if (!lastWasPath) {
        errors.push(`строка ${i + 1}: заголовок без пути перед ним -> "${trimmed.slice(0, 60)}"`)
      }
      if (!/^[A-Za-z0-9-]+:\s*\S/.test(trimmed)) {
        errors.push(`строка ${i + 1}: не похоже на "Имя: значение" -> "${trimmed.slice(0, 60)}"`)
      } else {
        headers++
      }
    }
  }
  return { errors, rules, headers }
}

console.log('=== _headers ===')
if (!existsSync('dist/_headers')) {
  console.log('FAIL dist/_headers отсутствует — сначала npm run build')
  process.exit(1)
}
const headersText = readFileSync('dist/_headers', 'utf8')
const h = validateHeaders(headersText)
check('файл разбирается без ошибок', h.errors.length === 0, h.errors.join('; '))
check('есть хотя бы одно правило', h.rules > 0, `правил ${h.rules}`)
check('есть заголовки', h.headers > 0, `заголовков ${h.headers}`)

// CSP обязателен: без него браузер не ограничивает источники.
check('CSP присутствует', /Content-Security-Policy:/i.test(headersText))
check('connect-src разрешает RPC', /connect-src[^;]*bscrpc\.pancakeswap\.finance/.test(headersText))

// ---------- _redirects ----------

console.log('\n=== _redirects ===')
if (!existsSync('dist/_redirects')) {
  console.log('FAIL dist/_redirects отсутствует')
  process.exit(1)
}
const redirects = readFileSync('dist/_redirects', 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))

const badRedirects = redirects.filter((l) => {
  const parts = l.split(/\s+/)
  // формат: <from> <to> [status]  ИЛИ  <from> <status>
  if (parts.length < 2) return true
  if (!parts[0].startsWith('/')) return true
  const status = parts[parts.length - 1]
  return !/^(\d{3}|!)$/.test(status)
})
check('все правила _redirects валидны', badRedirects.length === 0, badRedirects.join('; '))
check('есть SPA-фолбэк на index.html', redirects.some((l) => /\/index\.html/.test(l)))

// ---------- ловим исходный дефект ----------

console.log('\n=== регрессия: комментарий без # ломает файл ===')
const broken = '/*\n  X-Frame-Options: DENY\n  Русский текст без решётки\n'
const b = validateHeaders(broken)
check('битый файл определяется как ошибочный', b.errors.length > 0, `${b.errors.length} ошибок`)
// Текстовая строка с отступом внутри блока — «не похоже на заголовок».
// Строка без отступа вне правила — «путь должен начинаться с /».
// Оба варианта ловятся; проверяем, что поймали именно текстовую строку.
check(
  'ошибка указывает на текстовую строку',
  b.errors.some((e) => /не похоже на "Имя: значение"/.test(e)),
  b.errors[0] ?? ''
)

// ---------- index.html ----------

console.log('\n=== index.html ===')
const html = readFileSync('dist/index.html', 'utf8')
check('title на месте', /<title>[^<]+<\/title>/.test(html))
check('canonical на sementsul.net', /rel="canonical" href="https:\/\/sementsul\.net\//.test(html))
check('og:image абсолютный', /og:image" content="https:\/\/sementsul\.net\//.test(html))
check('есть noscript', /<noscript>/.test(html))
check('скрипт подключён как module', /<script type="module"[^>]*src="\/assets\//.test(html))
check('не осталось dev-пути /src/main.jsx', !html.includes('/src/main.jsx'))

// ---------- ассеты ----------

console.log('\n=== ассеты ===')
for (const f of ['sml-256.png', 'sml-512.png', 'favicon-64.png', 'apple-touch-icon.png', 'robots.txt', 'sitemap.xml']) {
  check(`${f} на месте`, existsSync(`dist/${f}`))
}
check('robots.txt ссылается на sitemap', readFileSync('dist/robots.txt', 'utf8').includes('sitemap.xml'))
check('sitemap содержит домен', readFileSync('dist/sitemap.xml', 'utf8').includes('sementsul.net'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
// Проверка графика на локальной сборке: реально ли грузится iframe
// DexScreener под нашим CSP и отрисовывается ли график внутри.
//
// Проверять надо именно в браузере: CSP — это правило, которое применяет
// браузер, а не файл на диске. Ошибка в директиве выглядит как «код есть, а
// графика нет», и статическая проверка `_headers` этого не поймает.
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'

const DIST = 'dist'
const PORT = 4198

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

// Заголовки берём из dist/_headers, чтобы тест проверял то, что реально
// задеплоится, а не то, что мы думаем о себе.
function loadHeaders() {
  const raw = readFileSync(join(DIST, '_headers'), 'utf8')
  const lines = raw.split(/\r?\n/)
  const out = {}
  for (const line of lines) {
    const m = line.match(/^\s{2}([A-Za-z-]+):\s*(.+)$/)
    if (m) out[m[1].toLowerCase()] = m[2].trim()
  }
  return out
}

const headers = loadHeaders()

const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/') p = '/index.html'
  let file = join(DIST, p)
  if (!existsSync(file) || !statSync(file).isFile()) {
    // SPA-фолбэк: любой неизвестный путь отдаёт index.html.
    file = join(DIST, 'index.html')
  }
  const body = readFileSync(file)
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    ...(p === '/index.html' || file.endsWith('index.html') ? headers : {}),
  })
  res.end(body)
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
const base = `http://127.0.0.1:${PORT}`

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`)
  }
}

console.log('\n=== CSP в собранной сборке ===\n')
const csp = headers['content-security-policy'] ?? ''
check('CSP присутствует', csp.length > 0)
check('frame-src разрешает dexscreener', /frame-src[^;]*https:\/\/dexscreener\.com/.test(csp), csp.slice(0, 120))
check('connect-src разрешает api.dexscreener.com', /connect-src[^;]*https:\/\/api\.dexscreener\.com/.test(csp))
check('frame-ancestors остался none', /frame-ancestors 'none'/.test(csp))
check('script-src по-прежнему только self', /script-src 'self'/.test(csp))

console.log('\n=== график в браузере ===\n')

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })

const cspViolations = []
page.on('console', (m) => {
  const txt = m.text()
  if (/Content Security Policy|Refused to frame/i.test(txt)) cspViolations.push(txt)
})

await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.header', { timeout: 20_000 })

// Переходим на страницу пулов. Вкладки идут в порядке обмена, пулов, базы
// знаний — берём вторую.
await page.locator('.nav-tab').nth(1).click()
await page.waitForTimeout(4000)

// Список грузится с цепи, поэтому ждём появления строк, а не фиксированной
// паузы. Если строк нет вовсе — сообщаем об этом отдельной проверкой, а не
// молча пропускаем весь блок.
const rowsAppeared = await page
  .waitForSelector('.pool-row', { timeout: 30_000 })
  .then(() => true)
  .catch(() => false)

check('список пулов загрузился', rowsAppeared)

const entered = rowsAppeared
  ? await page
      .locator('.pool-row')
      .first()
      .click({ timeout: 8000 })
      .then(() => true)
      .catch(() => false)
  : false

if (!entered) {
  console.log('  (пул открыть не удалось — возможно, список не загрузился без RPC)')
} else {
  await page.waitForTimeout(1200)
  const collapsed = await page.locator('.pool-chart-collapsed').count()
  check('график свёрнут по умолчанию', collapsed > 0, String(collapsed))

  const showBtn = page.locator('.pool-chart-collapsed .ghost-btn').first()
  const canShow = (await showBtn.count()) > 0
  check('есть кнопка «показать график»', canShow)

  if (canShow) {
    await showBtn.click()
    // Ждём либо iframe, либо сообщение «нет в DexScreener».
    await page.waitForSelector('.pool-chart-frame iframe, .pool-chart-missing', { timeout: 30_000 })

    const hasFrame = (await page.locator('.pool-chart-frame iframe').count()) > 0
    check('iframe либо сообщение об отсутствии, но не пустота', hasFrame || (await page.locator('.pool-chart-missing').count()) > 0)

    if (hasFrame) {
      const src = await page.locator('.pool-chart-frame iframe').getAttribute('src')
      check('в src есть embed=1', /embed=1/.test(src ?? ''), src ?? '')
      check('в src наш пул', /0x37c7702b/i.test(src ?? ''), src ?? '')

      // Даём странице загрузиться и смотрим, появился ли фрейм DexScreener.
      await page.waitForTimeout(15_000)
      const frames = page.frames().filter((f) => f.url().includes('dexscreener.com'))
      check('фрейм DexScreener загрузился', frames.length > 0, `фреймов: ${frames.length}`)

      // График TradingView живёт отдельным фреймом с canvas.
      const chartFrames = page.frames().filter((f) => f !== page.mainFrame() && f.url() === 'about:blank')
      let canvasTotal = 0
      for (const f of chartFrames) {
        canvasTotal += await f.evaluate(() => document.querySelectorAll('canvas').length).catch(() => 0)
      }
      check('график отрисован (canvas внутри фрейма)', canvasTotal > 0, `canvas: ${canvasTotal}`)

      const shot = await page.locator('.pool-chart-frame').screenshot()
      check('график не пустой (PNG крупный)', shot.length > 30_000, `${shot.length} байт`)
    }
  }

  check('нет нарушений CSP при загрузке графика', cspViolations.length === 0, cspViolations[0]?.slice(0, 120) ?? '')
}

await browser.close()
server.close()

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
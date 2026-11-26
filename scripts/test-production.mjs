// Проверка продакшена: то, что видит реальный посетитель на sementsul.net.
//
// Отдельно от локального набора: здесь проверяются заголовки, доступность
// эндпоинтов и то, что задеплоена именно текущая сборка. Локальные тесты
// этого не увидят — они работают с dist на диске.

import { chromium } from 'playwright-core'

const URL = process.argv[2] ?? 'https://sementsul.net'
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

console.log('\n=== HTTP ===\n')

async function head(url) {
  const r = await fetch(url, { redirect: 'follow' })
  return { status: r.status, headers: r.headers, body: await r.text() }
}

const home = await head(URL)
check('главная отвечает 200', home.status === 200, String(home.status))
check('есть CSP', Boolean(home.headers.get('content-security-policy')))
check('есть X-Content-Type-Options', home.headers.get('x-content-type-options') === 'nosniff')
check('есть Referrer-Policy', Boolean(home.headers.get('referrer-policy')))

const geo = await head(`${URL}/api/geo`)
check('/api/geo отвечает 200', geo.status === 200, String(geo.status))
check('/api/geo не кешируется', /no-store/.test(geo.headers.get('cache-control') ?? ''), geo.headers.get('cache-control'))

let geoBody = null
try {
  geoBody = JSON.parse(geo.body)
} catch {
  // тело не JSON — ниже отдельная проверка
}
check('/api/geo отдаёт JSON с полем country', Boolean(geoBody && 'country' in geoBody), geo.body.slice(0, 120))
check('/api/geo отдаёт hasIp', Boolean(geoBody && 'hasIp' in geoBody))
// Значение country зависит от того, откуда идёт запрос: у Cloudflare это
// может быть NL, DE или что угодно ещё. Проверяем формат, а не значение.
check(
  'country — двухбуквенный код или null',
  geoBody && (geoBody.country === null || /^[A-Z]{2}$/.test(geoBody.country)),
  String(geoBody?.country)
)

const sanctions = await head(`${URL}/sanctions/ofac-addresses.json`)
check('список санкций отвечает 200', sanctions.status === 200, String(sanctions.status))
let list = null
try {
  list = JSON.parse(sanctions.body)
} catch {
  // ниже
}
// addresses — объект-карта { "0x…": { names, programs } }, а не массив:
// так поиск по адресу в браузере сводится к одному обращению по ключу вместо
// перебора. Поэтому считаем ключи, а не длину массива.
const addrCount = list && typeof list.addresses === 'object' && list.addresses !== null
  ? Object.keys(list.addresses).length
  : 0
check('в списке больше 100 адресов', addrCount > 100, String(addrCount))
check(
  'счётчик в файле совпадает с числом записей',
  list?.count === addrCount,
  `count=${list?.count} фактически=${addrCount}`
)
check(
  'в файле есть дата сборки',
  typeof list?.generatedAt === 'string' && list.generatedAt.length > 0,
  String(list?.generatedAt)
)
// Один из адресов Lazarus должен присутствовать: это контрольная точка,
// которую проверяет и сборщик списка.
const hasLazarus = Object.values(list?.addresses ?? {}).some((e) =>
  (e?.names ?? []).some((n) => /LAZARUS/i.test(n))
)
check('список содержит запись Lazarus', hasLazarus)

console.log('\n=== страница в браузере ===\n')

const browser = await chromium.launch({ channel: 'chrome' })
const errors = []

try {
  // Английский посетитель.
  {
    const ctx = await browser.newContext({ locale: 'en-US' })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.header', { timeout: 20_000 })

    check('английская навигация на проде', (await page.locator('.nav').innerText()).includes('Swap'))

    // Условия.
    await page.locator('.nav-tab', { hasText: 'Terms' }).click()
    await page.waitForSelector('.terms-article', { timeout: 10_000 })
    const terms = await page.locator('.page').innerText()
    check('условия открываются на проде', terms.includes('Terms of Use'))
    check('раздел EEA на проде', terms.includes('European Economic Area'))
    check('MiCA на проде', terms.includes('MiCA'))
    check('версия документа на проде', /Version \d{4}-\d{2}-\d{2}/.test(terms), terms.slice(0, 150))

    const sections = await page.locator('.terms-article section').count()
    check('девять разделов на проде', sections === 9, String(sections))

    // База знаний на английском.
    await page.locator('.nav-tab', { hasText: 'Knowledge' }).click()
    await page.waitForSelector('.kb-list', { timeout: 10_000 })
    const kbCount = await page.locator('.kb-item').count()
    check('14 английских статей на проде', kbCount === 14, String(kbCount))

    await ctx.close()
  }

  // Русский посетитель.
  {
    const ctx = await browser.newContext({ locale: 'ru-RU' })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.header', { timeout: 20_000 })

    check('русская навигация на проде', (await page.locator('.nav').innerText()).includes('Обмен'))

    await page.locator('.nav-tab', { hasText: 'Условия' }).click()
    await page.waitForSelector('.terms-article', { timeout: 10_000 })
    const terms = await page.locator('.page').innerText()
    check('русские условия на проде', terms.includes('Условия использования'))
    check('ЕЭЗ на проде по-русски', terms.includes('ЕЭЗ'))

    await ctx.close()
  }

  // Переключение языка на живом сайте.
  {
    const ctx = await browser.newContext({ locale: 'ru-RU' })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.header', { timeout: 20_000 })

    await page.locator('.lang-btn', { hasText: 'EN' }).click()
    await page.waitForTimeout(400)
    check('переключение на EN на проде', (await page.locator('.nav').innerText()).includes('Swap'))

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.header', { timeout: 20_000 })
    check('выбор пережил перезагрузку на проде', (await page.locator('.nav').innerText()).includes('Swap'))

    await ctx.close()
  }
} finally {
  await browser.close()
}

console.log('\n=== ошибки страницы ===\n')
check('нет ошибок JavaScript на проде', errors.length === 0, errors.slice(0, 3).join(' | '))

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
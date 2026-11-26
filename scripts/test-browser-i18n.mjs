// Браузерная проверка локализации и условий использования.
//
// Запускается против локальной сборки (npx serve dist). Проверяем то, что
// нельзя проверить статически: что переключатель действительно меняет текст
// на экране, что выбор переживает перезагрузку, что язык по умолчанию берётся
// из браузера и что документ на двух языках открывается.
//
// Запуск:
//   node scripts/test-browser-i18n.mjs [url]
// По умолчанию http://localhost:4173.

import { chromium } from 'playwright-core'

const URL = process.argv[2] ?? 'http://localhost:4173'
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

async function withBrowser(fn) {
  const browser = await chromium.launch({ channel: 'chrome' })
  try {
    return await fn(browser)
  } finally {
    await browser.close()
  }
}

// Контекст с заданным языком браузера. locale влияет на navigator.language,
// но не на navigator.languages — поэтому прокидываем оба через init script.
async function newPage(browser, locale, extra = {}) {
  const ctx = await browser.newContext({ locale, ...extra })
  const page = await ctx.newPage()
  await page.addInitScript((lang) => {
    Object.defineProperty(navigator, 'languages', { get: () => [lang, 'en-US'] })
    Object.defineProperty(navigator, 'language', { get: () => lang })
  }, locale)
  return { ctx, page }
}

/// Ждём, пока приложение отрисуется: ищем шапку.
async function ready(page) {
  await page.waitForSelector('.header', { timeout: 15_000 })
}

const errors = []

await withBrowser(async (browser) => {
  console.log('\n=== язык по умолчанию из браузера ===\n')

  // Русский браузер.
  {
    const { ctx, page } = await newPage(browser, 'ru-RU')
    page.on('pageerror', (e) => errors.push(`ru: ${e.message}`))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await ready(page)

    const navText = await page.locator('.nav').innerText()
    check('русский браузер видит русскую навигацию', navText.includes('Обмен'), navText)
    check('русский браузер видит «Пулы»', navText.includes('Пулы'), navText)
    check('русский браузер видит «Условия»', navText.includes('Условия'), navText)

    const htmlLang = await page.getAttribute('html', 'lang')
    check('html lang=ru', htmlLang === 'ru', String(htmlLang))

    const active = await page.locator('.lang-btn.active').innerText()
    check('активна кнопка RU', active.trim() === 'RU', active)

    await ctx.close()
  }

  // Английский браузер — интерфейс должен быть английским без единого клика.
  {
    const { ctx, page } = await newPage(browser, 'en-US')
    page.on('pageerror', (e) => errors.push(`en: ${e.message}`))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await ready(page)

    const navText = await page.locator('.nav').innerText()
    check('английский браузер видит Swap', navText.includes('Swap'), navText)
    check('английский браузер видит Pools', navText.includes('Pools'), navText)
    check('английский браузер видит Terms', navText.includes('Terms'), navText)
    check('английский браузер НЕ видит «Обмен»', !navText.includes('Обмен'), navText)

    const htmlLang = await page.getAttribute('html', 'lang')
    check('html lang=en', htmlLang === 'en', String(htmlLang))

    const active = await page.locator('.lang-btn.active').innerText()
    check('активна кнопка EN', active.trim() === 'EN', active)

    // Текст внутри карточки обмена тоже должен быть английским.
    const card = await page.locator('.card').first().innerText()
    check('карточка обмена по-английски', card.includes('You pay'), card.slice(0, 120))
    check('карточка обмена: «You receive»', card.includes('You receive'), card.slice(0, 120))
    // В браузере без MetaMask кнопка называется «Install MetaMask», а не
// «Connect wallet» — проверяем именно то, что она английская, а не угадываем
// состояние кошелька. Оба варианта допустимы: тест не должен зависеть от
// того, установлено ли расширение на машине.
check(
  'кнопка кошелька по-английски',
  /Connect wallet|Install MetaMask/i.test(card),
  card.slice(0, 200)
)

    await ctx.close()
  }

  console.log('\n=== смена языка вручную ===\n')

  // Меняем язык кликом и проверяем, что текст сменился сразу.
  {
    const { ctx, page } = await newPage(browser, 'ru-RU')
    page.on('pageerror', (e) => errors.push(`switch: ${e.message}`))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await ready(page)

    check('до переключения — «Обмен»', (await page.locator('.nav').innerText()).includes('Обмен'))

    await page.locator('.lang-btn', { hasText: 'EN' }).click()
    await page.waitForTimeout(300)

    const afterNav = await page.locator('.nav').innerText()
    check('после переключения — Swap', afterNav.includes('Swap'), afterNav)
    check('после переключения нет «Обмен»', !afterNav.includes('Обмен'), afterNav)

    const afterCard = await page.locator('.card').first().innerText()
    check('карточка перевелась', afterCard.includes('You pay'), afterCard.slice(0, 120))

    const htmlLang = await page.getAttribute('html', 'lang')
    check('html lang переключился на en', htmlLang === 'en', String(htmlLang))

    // Выбор сохранён в localStorage под нашим ключом.
    const saved = await page.evaluate(() => localStorage.getItem('sml-dex:lang'))
    check('выбор сохранён в localStorage', saved === 'en', String(saved))

    // Перезагрузка: выбор должен пережить её, несмотря на русский браузер.
    await page.reload({ waitUntil: 'domcontentloaded' })
    await ready(page)
    const reloadedNav = await page.locator('.nav').innerText()
    check('после перезагрузки остался английский', reloadedNav.includes('Swap'), reloadedNav)
    check('после перезагрузки нет русского', !reloadedNav.includes('Обмен'), reloadedNav)

    // И обратно на русский — чтобы проверить, что переключение двустороннее.
    await page.locator('.lang-btn', { hasText: 'RU' }).click()
    await page.waitForTimeout(300)
    const backNav = await page.locator('.nav').innerText()
    check('возврат на русский работает', backNav.includes('Обмен'), backNav)
    const backSaved = await page.evaluate(() => localStorage.getItem('sml-dex:lang'))
    check('возврат сохранён', backSaved === 'ru', String(backSaved))

    await ctx.close()
  }

  console.log('\n=== страница условий ===\n')

  // Условия на русском.
  {
    const { ctx, page } = await newPage(browser, 'ru-RU')
    page.on('pageerror', (e) => errors.push(`terms-ru: ${e.message}`))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await ready(page)

    await page.locator('.nav-tab', { hasText: 'Условия' }).click()
    await page.waitForSelector('.terms-article', { timeout: 10_000 })

    const text = await page.locator('.page').innerText()
    check('заголовок «Условия использования»', text.includes('Условия использования'), text.slice(0, 80))
    check('есть версия документа', /Версия \d{4}-\d{2}-\d{2}/.test(text), text.slice(0, 200))
    check('есть сводка', text.includes('Интерфейс не хранит ваши средства'))
    check('есть раздел про ЕЭЗ', /Европ/.test(text) && text.includes('ЕЭЗ'))
    check('упомянут MiCA', text.includes('MiCA'))
    check('упомянуты санкции', text.includes('санкц'))
    check('упомянут JIT', text.includes('JIT'))
    check('есть отказ от гарантий', text.toLowerCase().includes('как есть'))

    // Все девять разделов должны отрендериться, а не только первый.
    const sections = await page.locator('.terms-article section').count()
    check('разделов отрендерено 9', sections === 9, String(sections))

    await ctx.close()
  }

  // Условия на английском.
  {
    const { ctx, page } = await newPage(browser, 'en-US')
    page.on('pageerror', (e) => errors.push(`terms-en: ${e.message}`))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await ready(page)

    await page.locator('.nav-tab', { hasText: 'Terms' }).click()
    await page.waitForSelector('.terms-article', { timeout: 10_000 })

    const text = await page.locator('.page').innerText()
    check('заголовок «Terms of Use»', text.includes('Terms of Use'), text.slice(0, 80))
    check('есть версия', /Version \d{4}-\d{2}-\d{2}/.test(text), text.slice(0, 200))
    check('есть раздел EEA', text.includes('European Economic Area'))
    check('упомянут MiCA', text.includes('MiCA'))
    check('упомянут CASP', text.includes('CASP'))
    check('упомянут ART/EMT', text.includes('ART') && text.includes('EMT'))
    check('нет кириллицы на английской странице', !/[А-Яа-яЁё]/.test(text), (text.match(/[А-Яа-яЁё]+/g) ?? []).slice(0, 5).join(', '))

    const sections = await page.locator('.terms-article section').count()
    check('разделов 9 и на английском', sections === 9, String(sections))

    await ctx.close()
  }

  console.log('\n=== база знаний на двух языках ===\n')

  {
    const { ctx, page } = await newPage(browser, 'en-US')
    page.on('pageerror', (e) => errors.push(`kb-en: ${e.message}`))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await ready(page)

    await page.locator('.nav-tab', { hasText: 'Knowledge' }).click()
    await page.waitForSelector('.kb-list', { timeout: 10_000 })

    const items = await page.locator('.kb-item').count()
    check('статей в списке 14', items === 14, String(items))

    const listText = await page.locator('.kb-list').innerText()
    check('список без кириллицы', !/[А-Яа-яЁё]/.test(listText), (listText.match(/[А-Яа-яЁё]+/g) ?? []).slice(0, 5).join(', '))

    // Открываем первую статью и проверяем, что тело тоже переведено.
    await page.locator('.kb-item').first().click()
    await page.waitForSelector('.kb-article', { timeout: 10_000 })
    const articleText = await page.locator('.kb-article').innerText()
    check('статья непустая', articleText.length > 500, String(articleText.length))
    check('тело статьи без кириллицы', !/[А-Яа-яЁё]/.test(articleText), (articleText.match(/[А-Яа-яЁё]+/g) ?? []).slice(0, 5).join(', '))

    await ctx.close()
  }

  // Русская база знаний осталась русской.
  {
    const { ctx, page } = await newPage(browser, 'ru-RU')
    page.on('pageerror', (e) => errors.push(`kb-ru: ${e.message}`))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await ready(page)

    await page.locator('.nav-tab', { hasText: 'База знаний' }).click()
    await page.waitForSelector('.kb-list', { timeout: 10_000 })

    const items = await page.locator('.kb-item').count()
    check('русских статей тоже 14', items === 14, String(items))

    const listText = await page.locator('.kb-list').innerText()
    check('русский список содержит кириллицу', /[А-Яа-яЁё]/.test(listText))

    await ctx.close()
  }

  console.log('\n=== вёрстка на узком экране ===\n')

  // Добавление переключателя языка расширяет шапку. На мобильной ширине это
  // главный риск: шапка может начать вылезать за экран, и появится
  // горизонтальная прокрутка, которой раньше не было.
  //
  // Проверяем несколько ширин, а не одну: 320 — самый узкий живой телефон,
  // 390 — iPhone, 768 — планшет, где шапка ещё может быть в одну строку.
  for (const width of [320, 390, 480, 768]) {
    const ctx = await browser.newContext({
      locale: 'en-US',
      viewport: { width, height: 844 },
    })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(`w${width}: ${e.message}`))
    await page.goto(URL, { waitUntil: 'domcontentloaded' })
    await ready(page)

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    )
    check(`нет горизонтальной прокрутки на ${width}px`, overflow <= 0, `${overflow}px`)

    const langBox = await page.locator('.lang-switch').boundingBox()
    check(
      `переключатель языка в пределах ${width}px`,
      langBox.x >= 0 && langBox.x + langBox.width <= width,
      JSON.stringify(langBox)
    )

    const walletBox = await page.locator('.wallet-btn').boundingBox()
    check(
      `кнопка кошелька в пределах ${width}px`,
      walletBox.x >= 0 && walletBox.x + walletBox.width <= width,
      JSON.stringify(walletBox)
    )

    await ctx.close()
  }
})

console.log('\n=== ошибки страницы ===\n')
// Ошибки JS на странице — отдельный класс дефектов: интерфейс может выглядеть
// правильно и при этом быть сломанным в обработчике.
check('нет ошибок JavaScript', errors.length === 0, errors.slice(0, 5).join(' | '))

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
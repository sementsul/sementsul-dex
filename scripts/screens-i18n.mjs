// Скриншоты для визуальной проверки локализации и страницы условий.
//
// Отдельный скрипт, а не часть тестов: снимки нужны человеку, тесты — машине.
// Складываем в .screens/, чтобы не попало в сборку.

import { chromium } from 'playwright-core'
import { mkdirSync } from 'node:fs'

const URL = process.argv[2] ?? 'http://localhost:4173'
const OUT = '.screens'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ channel: 'chrome' })

async function shot(locale, name, steps) {
  const ctx = await browser.newContext({ locale, viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  await page.addInitScript((lang) => {
    Object.defineProperty(navigator, 'languages', { get: () => [lang, 'en-US'] })
    Object.defineProperty(navigator, 'language', { get: () => lang })
  }, locale)
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.header', { timeout: 15_000 })
  // Даём котировке и загрузке балансов дорисоваться.
  await page.waitForTimeout(1200)
  if (steps) await steps(page)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: false })
  console.log(`${name}.png готов`)
  await ctx.close()
}

await shot('en-US', '01-swap-en')
await shot('ru-RU', '02-swap-ru')

await shot('en-US', '03-terms-en', async (page) => {
  await page.locator('.nav-tab', { hasText: 'Terms' }).click()
  await page.waitForSelector('.terms-article')
  await page.waitForTimeout(300)
})

await shot('ru-RU', '04-terms-ru', async (page) => {
  await page.locator('.nav-tab', { hasText: 'Условия' }).click()
  await page.waitForSelector('.terms-article')
  await page.waitForTimeout(300)
})

await shot('en-US', '05-pools-en', async (page) => {
  await page.locator('.nav-tab', { hasText: 'Pools' }).click()
  await page.waitForTimeout(2500)
})

await shot('en-US', '06-knowledge-en', async (page) => {
  await page.locator('.nav-tab', { hasText: 'Knowledge' }).click()
  await page.waitForSelector('.kb-list')
  await page.waitForTimeout(300)
})

// Прокрученная страница условий — чтобы увидеть раздел про ЕЭЗ.
await shot('en-US', '07-terms-eea-en', async (page) => {
  await page.locator('.nav-tab', { hasText: 'Terms' }).click()
  await page.waitForSelector('.terms-article')
  await page.locator('.terms-article section').nth(5).scrollIntoViewIfNeeded()
  await page.waitForTimeout(300)
})

// Мобильная ширина: переключатель языка не должен ломать шапку.
{
  const ctx = await browser.newContext({
    locale: 'en-US',
    viewport: { width: 390, height: 844 },
  })
  const page = await ctx.newPage()
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.header')
  await page.waitForTimeout(1200)
  await page.screenshot({ path: `${OUT}/08-mobile-en.png`, fullPage: false })
  console.log('08-mobile-en.png готов')
  await ctx.close()
}

await browser.close()
console.log(`\nснимки в ${OUT}/`)
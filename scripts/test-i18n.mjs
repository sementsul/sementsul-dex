// Проверки локализации: полнота словарей, поведение определения языка и
// отсутствие русских литералов в разметке.
//
// Смысл набора — не «перевод существует», а «перевод не разъехался». Словари
// правятся руками в двух местах, и ключ, добавленный только в русский, даёт
// пустое место в английском интерфейсе, а не ошибку сборки. Поэтому главная
// проверка здесь — симметрия множеств ключей.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src'
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

console.log('\n=== словари ===\n')

const i18nSrc = readFileSync('src/lib/i18n.js', 'utf8')
const { RU, EN, DICTS, LANGS, interpolate, translate, detectLang, loadLang } = await import(
  '../src/lib/i18n.js'
)

const ruKeys = Object.keys(RU)
const enKeys = Object.keys(EN)

check('языков ровно два', LANGS.length === 2 && LANGS.includes('ru') && LANGS.includes('en'))
check('словари непустые', ruKeys.length > 100 && enKeys.length > 100, `ru=${ruKeys.length} en=${enKeys.length}`)
check('ключей поровну', ruKeys.length === enKeys.length, `ru=${ruKeys.length} en=${enKeys.length}`)

const missingInEn = ruKeys.filter((k) => !(k in EN))
const missingInRu = enKeys.filter((k) => !(k in RU))
check('нет ключей только в русском', missingInEn.length === 0, missingInEn.join(', '))
check('нет ключей только в английском', missingInRu.length === 0, missingInRu.join(', '))

// Пустые значения — тот же дефект, что и отсутствующий ключ: пользователь
// увидит пустое место. Ловим отдельно.
const emptyRu = ruKeys.filter((k) => !String(RU[k]).trim())
const emptyEn = enKeys.filter((k) => !String(EN[k]).trim())
check('в русском нет пустых значений', emptyRu.length === 0, emptyRu.join(', '))
check('в английском нет пустых значений', emptyEn.length === 0, emptyEn.join(', '))

// Английский словарь не должен содержать кириллицу: это признак
// непереведённой строки, скопированной из русского.
//
// Исключение — ключи lang.*: в переключателе язык всегда подписан на самом
// себе («Русский», «English»), иначе человек, случайно попавший в чужой
// интерфейс, не найдёт дорогу назад.
const CYR_ALLOWED = new Set(['lang.ru'])
const cyrInEn = enKeys.filter(
  (k) => !CYR_ALLOWED.has(k) && /[А-Яа-яЁё]/.test(String(EN[k]))
)
check('в английских значениях нет кириллицы', cyrInEn.length === 0, cyrInEn.join(', '))

// Наборы плейсхолдеров должны совпадать: иначе {symbol} останется в тексте
// как есть, и пользователь увидит фигурные скобки.
function placeholders(s) {
  return [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
}
const phMismatch = ruKeys.filter((k) => placeholders(RU[k]) !== placeholders(EN[k]))
check('плейсхолдеры совпадают в обоих языках', phMismatch.length === 0, phMismatch.join(', '))

check('DICTS содержит оба словаря', DICTS.ru === RU && DICTS.en === EN)

console.log('\n=== подстановка ===\n')

check(
  'interpolate подставляет значение',
  interpolate('Баланс: {amount} {symbol}', { amount: '1.5', symbol: 'BNB' }) ===
    'Баланс: 1.5 BNB'
)
check(
  'interpolate без параметров возвращает шаблон',
  interpolate('Баланс: {amount}') === 'Баланс: {amount}'
)
check(
  'неизвестный плейсхолдер остаётся как есть',
  interpolate('{a} и {b}', { a: '1' }) === '1 и {b}'
)
check(
  'нулевое значение подставляется',
  interpolate('{n} мин', { n: 0 }) === '0 мин'
)

console.log('\n=== перевод ===\n')

check('translate(ru) отдаёт русский текст', translate('ru', 'nav.swap') === 'Обмен')
check('translate(en) отдаёт английский текст', translate('en', 'nav.swap') === 'Swap')
check(
  'translate подставляет параметры',
  translate('en', 'swap.balance', { amount: '2', symbol: 'USDT' }) === 'Balance: 2 USDT'
)
check('неизвестный ключ возвращается как ключ', translate('ru', 'нет.такого.ключа') === 'нет.такого.ключа')
check(
  'неизвестный язык падает на русский',
  translate('de', 'nav.swap') === 'Обмен'
)

console.log('\n=== определение языка ===\n')

// detectLang читает глобальный navigator. Подменяем его на время проверок и
// возвращаем обратно: иначе следующий тест в том же процессе увидит подмену.
const realNavigator = globalThis.navigator

function withNavigator(value, fn) {
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: realNavigator,
      configurable: true,
      writable: true,
    })
  }
}

check(
  'русский браузер -> ru',
  withNavigator({ languages: ['ru-RU', 'en-US'], language: 'ru-RU' }, detectLang) === 'ru'
)
check(
  'английский браузер -> en',
  withNavigator({ languages: ['en-US'], language: 'en-US' }, detectLang) === 'en'
)
check(
  'первый поддерживаемый из списка',
  withNavigator({ languages: ['de-DE', 'en-GB', 'ru-RU'], language: 'de-DE' }, detectLang) === 'en'
)
check(
  'неизвестный язык -> ru',
  withNavigator({ languages: ['ja-JP'], language: 'ja-JP' }, detectLang) === 'ru'
)
check('нет navigator -> ru', withNavigator(undefined, detectLang) === 'ru')
check(
  'битый navigator не роняет',
  withNavigator(
    {
      get languages() {
        throw new Error('приватный режим')
      },
    },
    detectLang
  ) === 'ru'
)

// loadLang: сохранённый выбор перекрывает браузер.
const realLocalStorage = globalThis.localStorage
function withStorage(value, fn) {
  Object.defineProperty(globalThis, 'localStorage', { value, configurable: true, writable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      value: realLocalStorage,
      configurable: true,
      writable: true,
    })
  }
}

const store = new Map()
const fakeStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, v),
  removeItem: (k) => store.delete(k),
}

check(
  'сохранённый выбор перекрывает браузер',
  withStorage(fakeStorage, () =>
    withNavigator({ languages: ['ru-RU'], language: 'ru-RU' }, () => {
      store.set('sml-dex:lang', 'en')
      return loadLang()
    })
  ) === 'en'
)

check(
  'мусор в хранилище игнорируется',
  withStorage(fakeStorage, () =>
    withNavigator({ languages: ['en-US'], language: 'en-US' }, () => {
      store.set('sml-dex:lang', 'klingon')
      return loadLang()
    })
  ) === 'en'
)

check(
  'недоступный localStorage не роняет',
  withStorage(undefined, () =>
    withNavigator({ languages: ['en-US'], language: 'en-US' }, loadLang)
  ) === 'en'
)

console.log('\n=== ключ хранения ===\n')

check(
  'ключ языка в том же пространстве имён',
  i18nSrc.includes("'sml-dex:lang'"),
  'ожидался префикс sml-dex:'
)
check(
  'атрибут lang документа выставляется',
  i18nSrc.includes('documentElement.lang')
)

console.log('\n=== литералы в разметке ===\n')

const CYR = /[А-Яа-яЁё]/

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.(jsx?|mjs)$/.test(p)) out.push(p)
  }
  return out
}

// Комментарии в проекте русские намеренно — это язык объяснений. Проверяем
// только то, что попадёт в разметку.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const i = line.indexOf('//')
      if (i === -1) return line
      const before = line.slice(0, i)
      const quoteCount = (before.match(/['"`]/g) ?? []).length
      return quoteCount % 2 === 0 ? before : line
    })
    .join('\n')
}

const SKIP = new Set([
  'src/lib/knowledge.js', // русская база знаний — так и задумано
  'src/lib/i18n.js', // сам словарь
  'src/lib/terms.js', // условия использования двуязычны
  'src/lib/compliance.js', // фолбэк-тексты для вызова без переводчика
  'src/lib/format.js', // фолбэк-сокращения для вызова без переводчика
  'src/lib/contracts.js', // остались только комментарии
  'src/lib/liquidity.js', // внутренние сообщения об ошибках, не UI
  'src/lib/quote.js', // внутренние сообщения об ошибках, не UI
  'src/lib/rpc.js', // внутренние сообщения об ошибках, не UI
  'src/lib/wallet.js', // внутренние сообщения об ошибках, не UI
])

const offenders = []
for (const file of walk(ROOT)) {
  const norm = file.replace(/\\/g, '/')
  if (SKIP.has(norm)) continue
  const src = stripComments(readFileSync(file, 'utf8'))
  src.split('\n').forEach((line, i) => {
    if (CYR.test(line)) offenders.push(`${norm}:${i + 1}: ${line.trim()}`)
  })
}

check(
  'в разметке не осталось русских литералов',
  offenders.length === 0,
  offenders.slice(0, 8).join(' | ')
)

// Итог в формате остальных наборов: scripts/test-all.mjs парсит именно эту
// строку, чтобы сложить общий счёт. Русская подпись выше — для человека,
// эта — для раннера.
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
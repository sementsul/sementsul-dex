// Проверка базы знаний и форматирования без браузера.
//
// Тексты и числа проверяем программно: опечатку в числе читатель не заметит,
// а она подорвёт доверие ко всему разделу.

import { ARTICLES, searchArticles, getArticle } from '../src/lib/knowledge.js'
import { formatAmount, formatUsd, parseAmount } from '../src/lib/format.js'

let fail = 0
let pass = 0
const check = (ok, label, extra = '') => {
  if (!ok) {
    console.log(`  FAIL  ${label} ${extra}`)
    fail++
  } else {
    console.log(`  ok    ${label}`)
    pass++
  }
}

console.log('=== статьи ===')
check(ARTICLES.length >= 8, `статей не меньше 8 (есть ${ARTICLES.length})`)

const ids = new Set()
for (const a of ARTICLES) {
  check(!ids.has(a.id), `id уникален: ${a.id}`)
  ids.add(a.id)
  check(typeof a.title === 'string' && a.title.length > 5, `заголовок: ${a.id}`)
  check(typeof a.summary === 'string' && a.summary.length > 10, `описание: ${a.id}`)
  check(Array.isArray(a.tags) && a.tags.length > 0, `теги: ${a.id}`)
  check(Array.isArray(a.body) && a.body.length >= 2, `разделов ≥2: ${a.id}`)
  for (const s of a.body) {
    check(typeof s.h === 'string' && s.h.length > 2, `заголовок раздела: ${a.id}`)
    check(Array.isArray(s.p) && s.p.length > 0, `абзацы: ${a.id} / ${s.h}`)
    for (const t of s.p) check(typeof t === 'string' && t.length > 20, `абзац содержателен: ${a.id}`)
  }
}

console.log('\n=== поиск ===')
check(searchArticles('').length === ARTICLES.length, 'пустой запрос отдаёт всё')
check(searchArticles('tvl').some((a) => a.id === 'tvl'), 'поиск по «tvl»')
check(searchArticles('арбитраж').some((a) => a.id === 'arbitrage'), 'поиск по «арбитраж»')
check(searchArticles('непостоянные').some((a) => a.id === 'impermanent-loss'), 'поиск по «непостоянные»')
check(searchArticles('щщщщщ').length === 0, 'бессмысленный запрос ничего не находит')
check(getArticle('fees') !== null, 'getArticle находит статью')
check(getArticle('нет-такой') === null, 'getArticle возвращает null для несуществующей')

console.log('\n=== числа в статьях ===')
// IL при росте в 2 раза: 2*sqrt(2)/3 - 1 = -5.72%
const il2 = (2 * Math.sqrt(2) / 3 - 1) * 100
check(Math.abs(il2 + 5.72) < 0.01, `IL при r=2 равна -5.72% (получилось ${il2.toFixed(2)}%)`)

// IL при росте в 5 раз: 2*sqrt(5)/6 - 1 = -25.46%
const il5 = (2 * Math.sqrt(5) / 6 - 1) * 100
check(Math.abs(il5 + 25.46) < 0.01, `IL при r=5 равна -25.46% (получилось ${il5.toFixed(2)}%)`)

// Эффективность V3 при ±2%
const eff = (pct) => 2 / (2 - Math.sqrt(1 / (1 + pct / 100)) - Math.sqrt(1 - pct / 100))
check(Math.abs(eff(2) - 100.5) < 0.6, `эффективность ±2% ≈ 100x (${eff(2).toFixed(1)})`)
check(Math.abs(eff(5) - 40.5) < 0.6, `эффективность ±5% ≈ 40x (${eff(5).toFixed(1)})`)
check(Math.abs(eff(10) - 20.4) < 0.6, `эффективность ±10% ≈ 20x (${eff(10).toFixed(1)})`)
check(Math.abs(eff(50) - 4.2) < 0.3, `эффективность ±50% ≈ 4x (${eff(50).toFixed(1)})`)

// Сдвиг цены: (1 + A/R)^2 - 1. R=500, A=100 -> 44%
const impact = ((1 + 100 / 500) ** 2 - 1) * 100
check(Math.abs(impact - 44) < 0.1, `сдвиг цены 100 в пуле с R=500: 44% (${impact.toFixed(1)}%)`)

// R=50000, A=100 -> 0.4%
const impact2 = ((1 + 100 / 50000) ** 2 - 1) * 100
check(Math.abs(impact2 - 0.4) < 0.01, `сдвиг цены 100 в пуле с R=50000: 0.4% (${impact2.toFixed(3)}%)`)

console.log('\n=== проверка текста статей на числа ===')
const byId = (id) => ARTICLES.find((a) => a.id === id)
const flat = (a) => a.body.flatMap((s) => s.p).join(' ')

// В тексте статей минус типографский (−, U+2212), а не дефис. Искать нужно
// именно его, иначе проверка «число есть в тексте» ложно проваливается.
const MINUS = '\u2212'
check(flat(byId('impermanent-loss')).includes(`${MINUS}5,7`), 'IL-статья содержит −5,7%')
check(flat(byId('impermanent-loss')).includes(`${MINUS}25,5`), 'IL-статья содержит −25,5%')
check(flat(byId('v2-vs-v3')).includes('100 раз'), 'V2/V3 статья содержит «100 раз»')
check(flat(byId('tvl')).includes('44%'), 'TVL-статья содержит 44%')
check(flat(byId('tvl')).includes('0,4%'), 'TVL-статья содержит 0,4%')

console.log('\n=== форматирование ===')
check(formatUsd(0) === '$0', 'formatUsd(0)')
check(formatUsd(0.5) === '$0.5000', 'formatUsd(0.5)')
check(formatUsd(1234.567) === '$1,234.57', 'formatUsd(1234.567)')
check(formatUsd(null) === '—', 'formatUsd(null) даёт прочерк')
check(formatUsd(NaN) === '—', 'formatUsd(NaN) даёт прочерк')
check(formatAmount(1000000000000000000n, 18) === '1', 'formatAmount: 1e18 при 18 dec = 1')
check(formatAmount(1n, 8) === '0.00000001', 'formatAmount: 1 при 8 dec')
check(parseAmount('1.5', 18) === 1500000000000000000n, 'parseAmount 1.5')
check(parseAmount('', 18) === 0n, 'parseAmount пусто = 0')
check(parseAmount('abc', 18) === 0n, 'parseAmount мусор = 0')

console.log(`\n${pass} passed, ${fail} failed`)
if (fail === 0) console.log('ВСЁ ПРОШЛО')
process.exit(fail === 0 ? 0 : 1)
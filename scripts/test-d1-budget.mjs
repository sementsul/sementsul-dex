// Регрессия на исчерпание лимита D1 и на пустую историю.
//
// Оба бага были невидимыми: API отвечал 200, интерфейс показывал пустой блок.
//
//   1. /api/candles делал 1 + 2*N запросов к D1. При limit=200 это 401
//      обращение за один HTTP-вызов, и каждое читало всю таблицу, потому что
//      фильтр по (ts / ?) * ? индекс не покрывает. Лимит 5 млн строк в сутки
//      выжигался за часы.
//   2. pair писался в EIP-55-виде одним регистром, а запрашивался другим.
//      SQLite сравнивает TEXT побайтово, поэтому `pair = ?` не находил НИЧЕГО,
//      и все эндпоинты отдавали пустые массивы при живых данных.
//
// Тест статический: читает исходники и падает, если вернётся любой из шаблонов.
// Сеть и D1 не нужны, поэтому он работает в общем наборе без секретов.

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const worker = readFileSync(join(ROOT, 'worker', 'index.js'), 'utf8')
const indexer = readFileSync(join(ROOT, 'scripts', 'index.mjs'), 'utf8')
const schema = readFileSync(join(ROOT, 'worker', 'schema.sql'), 'utf8')

let pass = 0
let fail = 0

function check(ok, label, detail = '') {
  if (ok) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('=== запросы к D1: не должно быть цикла с запросом на свечу ===')

// Признак старого бага: await внутри for-of по results в handleCandles.
const candlesFn = worker.slice(
  worker.indexOf('async function handleCandles'),
  worker.indexOf('async function handleTrades')
)

check(
  !/for\s*\([^)]*\)\s*\{[\s\S]*?await\s+env\.DB\.prepare/.test(candlesFn),
  'handleCandles не делает запрос в цикле по свечам',
  'вернулся N+1: 1 + 2*N обращений к D1'
)

const dbCalls = (candlesFn.match(/env\.DB\.prepare/g) ?? []).length
check(dbCalls === 1, `handleCandles обращается к D1 ровно один раз (сейчас ${dbCalls})`)

check(
  /ROW_NUMBER\(\)\s*OVER/.test(candlesFn),
  'open/close считаются оконной функцией в том же запросе'
)

// Параметры из JS приходят в SQLite как REAL, и (ts / 3600.0) * 3600.0 даёт
// исходный ts, а не начало бакета: каждая сделка попадает в свой «бакет», и
// вместо одной часовой свечи приходит по свече на сделку. Проверено на живой
// базе: 3 сделки в одном часе давали 3 свечи вместо 1.
check(
  /CAST\(\s*ts\s*\/\s*CAST\(\? AS INTEGER\)\s*AS INTEGER\s*\)\s*\*\s*CAST\(\? AS INTEGER\)/.test(candlesFn),
  'бакет считается целочисленным делением (иначе REAL-деление ломает группировку)',
  'параметры биндятся как REAL — нужен CAST(... AS INTEGER)'
)

// Смотрим только исполняемый SQL, а не комментарии: в пояснении к правке
// намеренно приведён старый вариант `(ts / ?) * ?`, и по тексту файла он
// находится, хотя в коде его нет.
const sqlText = candlesFn
  .replace(/\/\/.*$/gm, '')
  .replace(/`[^`]*`/g, (block) => block)

check(
  !/[^A-Z(]\(\s*ts\s*\/\s*\?\s*\)\s*\*\s*\?/.test(sqlText),
  'нет деления бакета на голый параметр без CAST'
)

console.log('\n=== регистр адреса пары ===')

check(
  /function normPair\(/.test(worker),
  'в воркере есть normPair()'
)

check(
  /normPair\(url\.searchParams\.get\('pair'\)\)/.test(worker),
  'все обработчики пропускают pair через normPair()',
  'без этого mixed-case снова даст пустой ответ'
)

// Значение по умолчанию обязано быть в нижнем регистре: иначе запрос
// без параметра pair повторит ту же ошибку.
const defaultPair = worker.match(/const DEFAULT_PAIR\s*=\s*'([^']+)'/)?.[1] ?? ''
check(
  defaultPair === defaultPair.toLowerCase(),
  'DEFAULT_PAIR записан в нижнем регистре',
  defaultPair
)

check(
  /\.toLowerCase\(\)/.test(indexer.slice(indexer.indexOf('const PAIR'), indexer.indexOf('const PAIR') + 400)),
  'индексатор приводит PAIR к нижнему регистру при записи',
  'иначе в базе снова появятся строки другого регистра'
)

// Сравнение через LOWER(pair) снимает индекс — именно это и жгло лимит.
check(
  !/WHERE\s+LOWER\(pair\)\s*=/.test(worker),
  'воркер не фильтрует через LOWER(pair) (это снимает индекс)'
)

console.log('\n=== индексы под реальные сортировки ===')

check(
  /idx_trades_pair_block/.test(schema),
  'есть индекс под ORDER BY block DESC, log_index DESC'
)

check(
  /ON trades \(pair, kind, block DESC, log_index DESC\)/.test(schema),
  'индекс покрывает именно тот порядок, что в запросах'
)

console.log('\n=== устойчивость к исчерпанному лимиту ===')

check(
  /D1_LIMIT/.test(worker),
  'при исчерпании лимита отдаётся код D1_LIMIT, а не голый 500'
)

check(
  /retry-after/i.test(worker),
  'есть заголовок retry-after — клиент знает, когда повторить'
)

check(
  /if \(cache && key && res\.ok\)/.test(worker) || /if \(!cache \|\| !key \|\| !res\.ok\) return res/.test(worker),
  'ошибки не кешируются (иначе 503 залипнет на весь TTL)'
)

// Заголовок обязан ставиться на ответ, который уходит клиенту. Раньше он
// выставлялся только на копию для кеша, и Cloudflare подставлял вместо него
// browser_cache_ttl зоны — 14400 секунд, то есть 4 часа на устаревшие данные.
check(
  /res\.headers\.set\(\s*'cache-control'/.test(worker),
  'cache-control ставится на ответ клиенту, а не только на копию в кеш',
  'иначе зона подменит TTL своим browser_cache_ttl'
)

check(
  /s-maxage=\$\{ttl\}/.test(worker),
  'есть s-maxage — им управляется кеш на границе'
)

// Браузер не должен держать ответ у себя.
//
// Это уже ломало интерфейс: при max-age=30 в «Последних сделках» висели
// данные 19-часовой давности, хотя API отдавал свежие. Причина — HTTP-кеш
// браузера: обычный fetch возвращал 1140 минут, а тот же запрос со случайным
// параметром — 17 минут. Поэтому max-age обязан быть 0 с must-revalidate:
// кеш живёт только на границе, где он и нужен для экономии чтений D1.
check(
  /max-age=0/.test(worker),
  'max-age=0 — браузер переспрашивает, а не показывает старьё'
)
check(
  /must-revalidate/.test(worker),
  'есть must-revalidate — устаревший ответ не отдаётся без проверки'
)
check(
  !/public, max-age=\$\{ttl\}, s-maxage/.test(worker),
  'нет старого заголовка max-age=${ttl}, из-за которого данные застревали'
)

console.log('\n=== кеш на границе ===')

const ttlBlock = worker.slice(worker.indexOf('const CACHE_TTL'), worker.indexOf('function cacheKeyFor'))
for (const route of ['/api/trades', '/api/stats', '/api/candles']) {
  check(ttlBlock.includes(`'${route}'`), `TTL задан для ${route}`)
}

check(
  /url\.search/.test(worker),
  'ключ кеша учитывает query (pair, interval, limit)'
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
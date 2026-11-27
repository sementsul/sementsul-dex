// Тесты геоблокировки на границе Cloudflare (/chain/).
//
// Что здесь важно проверить и почему:
//
//   1. Список стран в functions/chain/_middleware.js и в src/lib/compliance.js
//      физически не может быть одним импортом: Functions собираются отдельно
//      от фронтенда. Значит копий две, и они разойдутся молча. Тест сверяет
//      их между собой.
//
//   2. Отсутствие данных о стране НЕ должно блокировать. Иначе сломается
//      локальная разработка, curl, мониторинг и половина корпоративных
//      прокси, где CF-IPCountry не приходит.
//
//   3. Крым и Донбасс приходят как UA, поэтому проверяется регион.
import { readFileSync } from 'node:fs'
import { BLOCKED_COUNTRIES } from '../src/lib/compliance.js'

const middleware = readFileSync('functions/chain/_middleware.js', 'utf8')

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log('  ok  ', name, extra)
  } else {
    fail++
    console.log('  FAIL', name, extra)
  }
}

// Достаём множество стран из middleware текстом: импортировать оттуда
// нельзя, файл написан для рантайма Cloudflare.
const setMatch = middleware.match(/const BLOCKED = new Set\(\[([^\]]+)\]\)/)
if (!setMatch) {
  console.error('  FAIL: не найдено BLOCKED в middleware')
  process.exit(1)
}
const edgeCountries = setMatch[1]
  .split(',')
  .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
  .filter(Boolean)
  .sort()

const appCountries = Object.keys(BLOCKED_COUNTRIES).sort()

console.log('=== согласованность двух списков ===')
console.log('  edge:  ', edgeCountries.join(', '))
console.log('  app:   ', appCountries.join(', '))
check('множества совпадают', JSON.stringify(edgeCountries) === JSON.stringify(appCountries))
check('в edge есть Россия', edgeCountries.includes('RU'))
check('в edge есть Беларусь', edgeCountries.includes('BY'))
check('в edge есть Иран', edgeCountries.includes('IR'))
check('в edge есть КНДР', edgeCountries.includes('KP'))
check('в edge есть Сирия', edgeCountries.includes('SY'))
check('в edge есть Куба', edgeCountries.includes('CU'))
check('в edge НЕТ Украины как страны', !edgeCountries.includes('UA'))
check('в edge НЕТ Казахстана', !edgeCountries.includes('KZ'))
check('в edge НЕТ США', !edgeCountries.includes('US'))

console.log('\n=== регионы Украины ===')
const regionsMatch = middleware.match(/const BLOCKED_UA_REGIONS = \[([\s\S]*?)\]/)
check('список регионов есть', !!regionsMatch)
if (regionsMatch) {
  const regions = regionsMatch[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
  check('регионов не меньше пяти', regions.length >= 5, `${regions.length}`)
  check('есть crimea', regions.includes('crimea'))
  check('есть donetsk', regions.includes('donetsk'))
  check('есть luhansk', regions.includes('luhansk'))
  check('есть zaporizh', regions.includes('zaporizh'))
  check('есть kherson', regions.includes('kherson'))
}

console.log('\n=== поведение обработчика ===')
check('возвращает 451', middleware.includes('status: 451'))
// Пропуск без данных о стране: ветка есть, но теперь она сначала получает
// ответ, чтобы добавить диагностический заголовок. Проверяем сам факт
// отсутствия блокировки в этой ветке, а не форму записи return next().
check('пропускает без данных о стране', /if \(!country\) \{[\s\S]*?await next\(\)/.test(middleware))
check(
  'не блокирует при пустом country',
  !/if \(!country\)[\s\S]{0,300}blockedPage/.test(middleware)
)
check('проверяет регион только для UA', middleware.includes("country === 'UA'"))
check('не индексируется', middleware.includes('noindex'))
check('ставит диагностический заголовок', middleware.includes('x-geo-middleware'))

// Проверим логику на копии, прогнав несколько сценариев через ту же
// последовательность условий, что в middleware.
function decide(cf) {
  const country = typeof cf.country === 'string' ? cf.country.toUpperCase() : null
  if (!country) return 'pass'
  if (edgeCountries.includes(country)) return 'block:' + country
  if (country === 'UA') {
    const hay = [cf.region, cf.regionCode].filter((v) => typeof v === 'string').join(' ').toLowerCase()
    if (hay.trim() && ['crimea', 'krym', 'sevastopol', 'donetsk', 'donetska', 'luhansk', 'luhanska', 'zaporizh', 'kherson'].some((n) => hay.includes(n))) {
      return 'block:region'
    }
  }
  return 'pass'
}

console.log('\n=== сценарии ===')
const cases = [
  [{ country: 'RU' }, 'block:RU', 'Москва'],
  [{ country: 'BY' }, 'block:BY', 'Минск'],
  [{ country: 'IR' }, 'block:IR', 'Тегеран'],
  [{ country: 'US' }, 'pass', 'Нью-Йорк'],
  [{ country: 'DE' }, 'pass', 'Берлин'],
  [{ country: 'KZ' }, 'pass', 'Алматы'],
  [{ country: 'UA', region: 'Crimea' }, 'block:region', 'Крым'],
  [{ country: 'UA', region: 'Kyiv' }, 'pass', 'Киев'],
  [{ country: 'UA', region: 'Lviv' }, 'pass', 'Львов'],
  [{}, 'pass', 'нет данных'],
  [{ country: undefined }, 'pass', 'country undefined'],
  [{ country: 'ru' }, 'block:RU', 'нижний регистр'],
]
for (const [cf, expected, label] of cases) {
  const got = decide(cf)
  check(label, got === expected, `-> ${got}`)
}

console.log('\n=== маршруты ===')
const routes = JSON.parse(readFileSync('public/_routes.json', 'utf8'))
check('/chain/* включён в Functions', routes.include.includes('/chain/*'))
check('/chain/loader.js исключён (статика быстрее)', routes.exclude.includes('/chain/loader.js'))
check('/api/* по-прежнему включён', routes.include.includes('/api/*'))

console.log('\n  ', pass, 'passed,', fail, 'failed')
process.exit(fail === 0 ? 0 : 1)
// Проверка, что документация о комплаенсе не расходится с кодом.
//
// Зачем: в этом документе легко написать «блокируем подсанкционные
// юрисдикции» и забыть, что Россия в список не входит. Или наоборот —
// заявить полноценный AML, которого нет. Оба случая опасны: первый даёт
// ложное чувство защиты, второй вводит пользователя в заблуждение.
import { readFileSync } from 'node:fs'
import {
  BLOCKED_COUNTRIES,
  BLOCKED_UA_REGIONS,
} from '../src/lib/compliance.js'

let passed = 0
let failed = 0
function check(name, ok, extra = '') {
  if (ok) {
    passed++
    console.log(`  ok   ${name}${extra ? '  ' + extra : ''}`)
  } else {
    failed++
    console.log(`  ФЕЙЛ ${name}${extra ? '  ' + extra : ''}`)
  }
}

const doc = readFileSync('docs/COMPLIANCE.md', 'utf8')

console.log('\n=== документ существует и содержателен ===')
check('файл не пустой', doc.length > 2000, `${doc.length} символов`)
check('есть заголовок', doc.startsWith('#'))

console.log('\n=== честность формулировок ===')

// Документ обязан прямо сказать, что это не полноценный AML.
check(
  'сказано, что графового анализа нет',
  /графов|TRM|Chainalysis/i.test(doc)
)
check(
  'сказано, что список — это «кого поймали»',
  /явно|внесён|внесены|список/i.test(doc)
)
check(
  'сказано, что фронтенд обходится',
  /обходит|обойти|не граница безопасности|барьер/i.test(doc)
)

console.log('\n=== список стран совпадает с кодом ===')

// Каждая заблокированная страна должна быть названа в документе.
const COUNTRY_NAMES = {
  IR: ['Иран', 'Ирана'],
  KP: ['КНДР', 'Корея'],
  SY: ['Сирия', 'Сирии'],
  CU: ['Куба', 'Кубы'],
}
for (const [code, names] of Object.entries(COUNTRY_NAMES)) {
  const inDoc = names.some((n) => doc.includes(n))
  check(`в документе упомянута ${names[0]} (${code})`, inDoc)
  check(`в коде есть ${code}`, Boolean(BLOCKED_COUNTRIES[code]))
}

// России не должно быть в списке блокировки — и документ обязан это
// объяснить, иначе читатель решит, что это недосмотр.
check('России нет в списке блокировки', !BLOCKED_COUNTRIES.RU)
check(
  'документ объясняет, почему Россия не заблокирована',
  /Росси[яию].{0,200}(секторал|не всеобъемл|не входит|не блокир)|(секторал|не всеобъемл).{0,200}Росси/i.test(
    doc
  )
)

console.log('\n=== регионы ===')
check('в коде есть Крым', BLOCKED_UA_REGIONS.includes('crimea'))
check('документ упоминает Крым', /Крым/i.test(doc))
check('документ упоминает Донбасс или Донецк', /Донбасс|Донецк/i.test(doc))
check(
  'документ предупреждает о неточности определения региона',
  /эвристик|может ошибаться|ошибк|неточн/i.test(doc)
)

console.log('\n=== источник данных ===')
check('указан OFAC', /OFAC/i.test(doc))
check('указан адрес источника', /sanctionslistservice|treasury\.gov/i.test(doc))
check('сказано про исключение Tornado Cash', /Tornado/i.test(doc))
check(
  'документ описывает, как обновить список',
  /build-sanctions-list|обнов/i.test(doc)
)

console.log('\n=== точки блокировки описаны ===')
check('упомянут sendTransaction', /sendTransaction/i.test(doc))
check('упомянут /api/geo', /\/api\/geo/.test(doc))
check('упомянут useCompliance', /useCompliance|compliance\.js/i.test(doc))

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
// Проверки условий использования.
//
// Юридический текст проверять тестами целиком нельзя — но можно проверить то,
// что ломается механически: структура разделов на двух языках разъехалась,
// пункт про ЕЭЗ потерялся при правке, версия не совпадает с той, что на
// странице. Именно эти дефекты здесь и ловятся.
//
// Отдельно проверяется наличие обязательных по сути утверждений: что
// интерфейс некастодиальный, что комиссии протокола нет, что упомянуты
// MEV/JIT и ЕЭЗ. Это те обещания, которые пользователь читает первыми.

import { readFileSync } from 'node:fs'

const { TERMS, TERMS_SUMMARY, TERMS_VERSION } = await import('../src/lib/terms.js')

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

console.log('\n=== структура ===\n')

check('есть русская версия', Array.isArray(TERMS.ru) && TERMS.ru.length > 0)
check('есть английская версия', Array.isArray(TERMS.en) && TERMS.en.length > 0)
check(
  'разделов поровну',
  TERMS.ru.length === TERMS.en.length,
  `ru=${TERMS.ru.length} en=${TERMS.en.length}`
)

const ruIds = TERMS.ru.map((s) => s.id)
const enIds = TERMS.en.map((s) => s.id)
check('id разделов совпадают по порядку', JSON.stringify(ruIds) === JSON.stringify(enIds))
check('id разделов уникальны', new Set(ruIds).size === ruIds.length)

// Пропущенный абзац в одном языке — самая частая ошибка при правке: правят
// русский, английский забывают. Проверяем количество абзацев в каждом разделе.
const paraMismatch = TERMS.ru.filter(
  (s, i) => s.paragraphs.length !== TERMS.en[i].paragraphs.length
)
check('абзацев в разделах поровну', paraMismatch.length === 0, paraMismatch.map((s) => s.id).join(', '))

check(
  'у каждого раздела есть заголовок',
  TERMS.ru.every((s) => s.title?.trim()) && TERMS.en.every((s) => s.title?.trim())
)
check(
  'ни один абзац не пустой',
  [...TERMS.ru, ...TERMS.en].every((s) => s.paragraphs.every((p) => p?.trim()))
)

console.log('\n=== версия и сводка ===\n')

check('версия задана', /^\d{4}-\d{2}-\d{2}$/.test(TERMS_VERSION), TERMS_VERSION)

const d = new Date(TERMS_VERSION)
check('версия — существующая дата', !Number.isNaN(d.getTime()))

check('сводка на обоих языках', TERMS_SUMMARY.ru.length > 0 && TERMS_SUMMARY.en.length > 0)
check(
  'пунктов сводки поровну',
  TERMS_SUMMARY.ru.length === TERMS_SUMMARY.en.length,
  `ru=${TERMS_SUMMARY.ru.length} en=${TERMS_SUMMARY.en.length}`
)
check('в сводке 3-5 пунктов', TERMS_SUMMARY.ru.length >= 3 && TERMS_SUMMARY.ru.length <= 5)

console.log('\n=== обязательные утверждения ===\n')

// Собираем весь текст документа в одну строку на язык: искать по разделам
// значило бы привязать тест к тому, в каком именно разделе лежит мысль.
const ruAll = TERMS.ru.flatMap((s) => [s.title, ...s.paragraphs]).join(' ').toLowerCase()
const enAll = TERMS.en.flatMap((s) => [s.title, ...s.paragraphs]).join(' ').toLowerCase()

function present(text, patterns, label) {
  const missing = patterns.filter((p) => !text.includes(p))
  check(label, missing.length === 0, missing.join(', '))
}

present(
  ruAll,
  ['не является биржей', 'не хранит', 'не взимает', 'не обещаем доходность'],
  'ru: некастодиальность и отсутствие платы заявлены'
)
present(
  enAll,
  ['not an exchange', 'does not receive, hold or transfer', 'charges nothing', 'do not promise'],
  'en: некастодиальность и отсутствие платы заявлены'
)

present(ruAll, ['jit', 'mev', 'сэндвич'], 'ru: MEV и JIT упомянуты')
present(enAll, ['jit', 'mev', 'sandwich'], 'en: MEV и JIT упомянуты')

// Пункт про ЕЭЗ — то, ради чего этот документ и правился. Проверяем и
// аббревиатуру, и MiCA: без ссылки на регламент формулировка бессмысленна.
//
// Ищем по основе «европейск», а не по полной форме: в заголовке раздел
// называется «Европейская экономическая зона», а в тексте — «в Европейской
// экономической зоне», и привязка к падежу делала бы тест хрупким.
present(ruAll, ['европейск', 'еэз', 'mica'], 'ru: ЕЭЗ и MiCA упомянуты')
present(enAll, ['european economic area', 'mica'], 'en: ЕЭЗ и MiCA упомянуты')
present(
  ruAll,
  ['не является поставщиком криптоуслуг', 'casp'],
  'ru: отказ от статуса CASP'
)
present(
  enAll,
  ['not a crypto-asset service provider', 'casp'],
  'en: отказ от статуса CASP'
)
present(ruAll, ['art', 'emt'], 'ru: ART и EMT упомянуты')
present(enAll, ['art', 'emt'], 'en: ART и EMT упомянуты')

// Санкционный раздел должен называть конкретные юрисдикции и OFAC.
present(ruAll, ['иран', 'корейскую', 'сирию', 'кубу', 'ofac'], 'ru: санкционные юрисдикции перечислены')
present(enAll, ['iran', 'korea', 'syria', 'cuba', 'ofac'], 'en: санкционные юрисдикции перечислены')
present(ruAll, ['европейского союза'], 'ru: санкции ЕС упомянуты')
present(enAll, ['european union'], 'en: санкции ЕС упомянуты')

// Отказ от гарантий и ограничение ответственности — раздел, без которого
// документ не имеет смысла.
present(ruAll, ['как есть', 'не несём ответственности'], 'ru: отказ от гарантий')
present(enAll, ['as is', 'not liable'], 'en: отказ от гарантий')

console.log('\n=== согласованность с остальным проектом ===\n')

// Тот же список стран, что и в комплаенсе: если в ToS перечислены одни
// страны, а блокируются другие, документ врёт.
const complianceSrc = readFileSync('src/lib/compliance.js', 'utf8')
check(
  'ToS и комплаенс перечисляют одни страны',
  ['IR', 'KP', 'SY', 'CU'].every((c) => complianceSrc.includes(`${c}:`)),
  'проверьте BLOCKED_COUNTRIES'
)

// Условия должны быть доступны из интерфейса, а не лежать мёртвым файлом.
const appSrc = readFileSync('src/App.jsx', 'utf8')
check('страница условий подключена в App', appSrc.includes('TermsPage'))
check('на условия есть ссылка в навигации', appSrc.includes("t('nav.terms')"))

const termsPageSrc = readFileSync('src/components/TermsPage.jsx', 'utf8')
check('страница читает тексты из terms.js', termsPageSrc.includes("from '../lib/terms.js'"))
check(
  'страница показывает версию',
  termsPageSrc.includes('TERMS_VERSION')
)

// Утверждение о комиссии должно совпадать с тем, что написано в базе знаний:
// расхождение здесь — прямая дезинформация о деньгах.
const knowledgeSrc = readFileSync('src/lib/knowledge.js', 'utf8')
check(
  'база знаний не обещает комиссию протокола',
  !/Протокол может включить свою долю/.test(knowledgeSrc),
  'в knowledge.js остался устаревший абзац про feeTo'
)
check(
  'база знаний утверждает отсутствие доли протокола',
  knowledgeSrc.includes('Доли протокола нет вовсе')
)

// Итог в формате остальных наборов: scripts/test-all.mjs парсит именно эту
// строку, чтобы сложить общий счёт. Русская подпись выше — для человека,
// эта — для раннера.
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
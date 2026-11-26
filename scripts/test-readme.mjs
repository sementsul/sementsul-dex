// Проверка, что README не ссылается на несуществующие файлы и наборы тестов.
//
// Документация врёт тихо: ссылка на переименованный скрипт выглядит как
// ссылка, пока кто-то по ней не кликнет. Ловим это здесь.
import { readFileSync, existsSync } from 'node:fs'

const readme = readFileSync('README.md', 'utf8')
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

// Все упоминания вида `scripts/xxx.mjs`, `src/...`, `docs/...` в обратных
// кавычках или markdown-ссылках.
const refs = new Set()
for (const m of readme.matchAll(/`((?:scripts|src|docs|test|public|functions)\/[\w./-]+)`/g)) {
  refs.add(m[1])
}
for (const m of readme.matchAll(/\]\(([\w./-]+\.(?:md|mjs|js|jsx|sol))\)/g)) {
  refs.add(m[1])
}

check('README ссылается на файлы', refs.size > 10, `найдено ${refs.size}`)

const missing = [...refs].filter((p) => !existsSync(p))
check('все упомянутые файлы существуют', missing.length === 0, missing.join(', '))

// Наборы тестов, перечисленные в таблице, должны быть в SUITES.
const testAll = readFileSync('scripts/test-all.mjs', 'utf8')
const listed = [...readme.matchAll(/`(test-[\w-]+\.mjs)`/g)].map((m) => m[1])
const uniqueListed = [...new Set(listed)]
const notInRunner = uniqueListed.filter((s) => !testAll.includes(s))
check(
  'все наборы из README подключены к test-all',
  notInRunner.length === 0,
  notInRunner.join(', ')
)

// Обратное: каждый набор в раннере должен быть описан в README, иначе о нём
// никто не узнает.
const suiteMatches = [...testAll.matchAll(/'(\w[\w-]+\.mjs)'/g)].map((m) => m[1])
const undocumented = [...new Set(suiteMatches)].filter((s) => !readme.includes(s))
check(
  'у каждого набора есть строка в README',
  undocumented.length === 0,
  undocumented.join(', ')
)

// Число проверок в README не должно сильно расходиться с реальностью.
// Точное сравнение здесь плохо: счёт меняется при каждой правке тестов.
//
// Форму слова ловим любую: «936 проверок», «942 проверки», «1001 проверка» —
// по-русски окончание зависит от числа, и привязка к одному варианту ломала
// тест при каждой правке счёта.
const totalMatch = readme.match(/все наборы: (\d+) провер(?:ок|ки|ка)/)
check('в README указано число проверок', Boolean(totalMatch), 'не нашёл «все наборы: N проверок»')
if (totalMatch) {
  const claimed = Number(totalMatch[1])
  check('число проверок правдоподобно', claimed >= 900 && claimed <= 1200, String(claimed))
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
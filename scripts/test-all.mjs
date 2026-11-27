// Запуск всех тестов контрактов и клиентской математики.
//
// Тесты идут отдельными процессами: у каждого своя EVM, и падение одного не
// должно скрывать результаты остальных. Итог — сводка, а код возврата
// ненулевой, если упал хотя бы один набор.
//
// Использование:
//   node scripts/test-all.mjs

import { spawn } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const SUITES = [
  ['математика V3 (TickMath, FullMath, SwapMath)', 'test-math.mjs'],
  ['пулы V2 и роутер', 'test-v2.mjs'],
  ['пул V3 (один диапазон)', 'test-v3.mjs'],
  ['ступени V3 (несколько диапазонов)', 'test-ranges.mjs'],
  ['математика комиссий на клиенте', 'test-fee-math.mjs'],
  ['токен SEM (отсутствие рычагов)', 'test-token.mjs'],
  ['токен SEM в пулах V2 и V3', 'test-token-dex.mjs'],
  ['подпись и калибровка деплоя', 'test-deploy-signing.mjs'],
  ['газ транзакций (потолок RPC)', 'test-gas.mjs'],
  ['разбор Swap-событий', 'test-swap-parsing.mjs'],
  ['бюджет D1 и регистр адреса пары', 'test-d1-budget.mjs'],
  ['вывод средств (защита от молчаливых ошибок)', 'test-withdraw.mjs'],
  ['комплаенс: гео и санкционный список', 'test-compliance.mjs'],
  ['комплаенс: гейт транзакций и dist', 'test-compliance-integration.mjs'],
  ['комплаенс: документация против кода', 'test-compliance-docs.mjs'],
  ['зеркало на IPFS: относительные пути и честный гео-статус', 'test-mirror.mjs'],
  ['локализация: словари, определение языка, литералы', 'test-i18n.mjs'],
  ['условия использования и пункт про ЕЭЗ', 'test-terms.mjs'],
  ['README против файлов и набора тестов', 'test-readme.mjs'],
  ['база знаний и форматирование', 'test-knowledge.mjs'],
]

function run(script) {
  return new Promise((resolve) => {
    // stdio: 'inherit' — вывод идёт напрямую: буферизовать его и печатать
    // потом значит потерять порядок строк при падении.
    const child = spawn(process.execPath, [join('scripts', script)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let out = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.on('close', (code) => {
      const m = out.match(/(\d+) passed, (\d+) failed/)
      resolve({
        code,
        passed: m ? Number(m[1]) : 0,
        failed: m ? Number(m[2]) : code === 0 ? 0 : 1,
        out,
      })
    })
  })
}

/// Прогон Foundry-наборов.
///
/// Итог берётся из последней строки сводки: искать первое «N failed» нельзя,
/// потому что оно попадается уже в строке первого набора и всегда равно нулю.
function runForge(forge) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(
        forge,
        // Fork.t.sol требует живую сеть (--fork-url) и падает без неё, потому
        // что настоящего WBNB в пустой EVM нет. Это не поломка, а свойство
        // теста: он проверяет именно реальную сеть. Запускается отдельно:
        //   forge test --match-path "test/Fork.t.sol" --fork-url <RPC>
        ['test', '--no-match-path', 'test/Fork.t.sol'],
        { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] }
      )
    } catch {
      resolve({ skipped: true, failed: 0, passed: 0, out: '' })
      return
    }

    let out = ''
    child.stdout.on('data', (d) => {
      out += d.toString()
    })
    child.on('error', () => resolve({ skipped: true, failed: 0, passed: 0, out: '' }))
    child.on('close', (code) => {
      // Берём именно итоговую строку «Ran N test suites ... : X tests passed».
      // Общий шаблон «N passed» ловит ещё и сводку последнего набора, где
      // число меньше итогового, — из-за этого счёт занижался.
      const total = out.match(/Ran \d+ test suites?[^:]*:\s*(\d+) tests? passed,\s*(\d+) failed/)
      let passed
      let failed
      if (total) {
        passed = Number(total[1])
        failed = Number(total[2])
      } else {
        const passedAll = [...out.matchAll(/(\d+)\s+tests?\s+passed/g)].map((m) => Number(m[1]))
        const failedAll = [...out.matchAll(/(\d+)\s+failed/g)].map((m) => Number(m[1]))
        passed = passedAll.length ? passedAll[passedAll.length - 1] : 0
        failed = failedAll.length ? failedAll[failedAll.length - 1] : code === 0 ? 0 : 1
      }
      resolve({ skipped: false, code, passed, failed, out })
    })
  })
}

const results = []
for (const [label, script] of SUITES) {
  process.stdout.write(`${label.padEnd(44)} `)
  const r = await run(script)
  if (r.failed === 0) {
    console.log(`OK   ${r.passed} проверок`)
  } else {
    console.log(`FAIL ${r.passed} прошло, ${r.failed} упало`)
    // Показываем только строки провалов: полный вывод уже был в потоке.
    for (const line of r.out.split('\n').filter((l) => l.includes('FAIL'))) {
      console.log(`     ${line.trim()}`)
    }
  }
  results.push({ label, ...r })
}

const totalPassed = results.reduce((s, r) => s + r.passed, 0)
const totalFailed = results.reduce((s, r) => s + r.failed, 0)

// Foundry-наборы идут отдельно: у них другой вывод и другой инструмент.
// Если forge не установлен, это не провал — просто пропускаем с пометкой,
// иначе тесты нельзя будет запустить на машине без Foundry.
const forge = process.env.FORGE_PATH ?? join(process.env.TEMP ?? '', 'foundry-bin', 'forge.exe')

process.stdout.write(`${'Foundry: фаззинг и инварианты'.padEnd(44)} `)
const forgeResult = await runForge(forge)
if (forgeResult.skipped) {
  console.log('ПРОПУЩЕН (forge не найден)')
} else if (forgeResult.failed === 0) {
  console.log(`OK   ${forgeResult.passed} тестов`)
} else {
  console.log(`FAIL ${forgeResult.passed} прошло, ${forgeResult.failed} упало`)
  for (const line of forgeResult.out.split('\n').filter((l) => l.includes('FAIL'))) {
    console.log(`     ${line.trim()}`)
  }
}
results.push({ label: 'Foundry: фаззинг и инварианты', ...forgeResult })

// Браузерные проверки требуют запущенного сервера и установленного Chrome,
// Браузерные наборы требуют Chrome и собранного dist, поэтому по умолчанию
// пропускаются: иначе тесты нельзя будет запустить на машине без них. Включаются
// явно:
//   npm run build
//   npx serve dist -l 4173        (в отдельном окне)
//   BROWSER_TESTS=1 npm test
// URL можно переопределить через BROWSER_URL.
//
// test-browser-chart.mjs поднимает свой сервер с заголовками из dist/_headers,
// поэтому BROWSER_URL ему не нужен: CSP проверяется только с реальными
// заголовками, а `serve` их не отдаёт.
const BROWSER_SUITES = [
  { label: 'браузер: язык и условия использования', script: 'test-browser-i18n.mjs', args: [] },
  { label: 'браузер: график пула и CSP', script: 'test-browser-chart.mjs', args: [] },
]

const browserTotals = { passed: 0, failed: 0 }

for (const suite of BROWSER_SUITES) {
  process.stdout.write(`${suite.label.padEnd(44)} `)
  let result
  if (process.env.BROWSER_TESTS === '1') {
    const url = process.env.BROWSER_URL ?? 'http://localhost:4173'
    const argv = [join('scripts', suite.script)]
    if (suite.script === 'test-browser-i18n.mjs') argv.push(url)
    result = await new Promise((resolve) => {
      const child = spawn(process.execPath, argv, {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      let out = ''
      child.stdout.on('data', (d) => {
        out += d.toString()
      })
      child.on('close', (code) => {
        const m = out.match(/(\d+) passed, (\d+) failed/)
        resolve({ code, passed: m ? Number(m[1]) : 0, failed: m ? Number(m[2]) : 1, out })
      })
    })
    if (result.failed === 0) {
      console.log(`OK   ${result.passed} проверок`)
    } else {
      console.log(`FAIL ${result.passed} прошло, ${result.failed} упало`)
      for (const line of result.out.split('\n').filter((l) => l.includes('FAIL'))) {
        console.log(`     ${line.trim()}`)
      }
    }
  } else {
    console.log('ПРОПУЩЕН (BROWSER_TESTS=1 для запуска)')
    result = { skipped: true, passed: 0, failed: 0 }
  }
  results.push({ label: suite.label, ...result })
  browserTotals.passed += result.passed ?? 0
  browserTotals.failed += result.failed ?? 0
}

const bad = results.filter((r) => r.failed > 0)

const browserPassed = browserTotals.passed
const browserFailed = browserTotals.failed

console.log(`\nитого: ${totalPassed + (forgeResult.passed ?? 0) + browserPassed} проверок прошло, ${totalFailed + (forgeResult.failed ?? 0) + browserFailed} упало`)
if (bad.length) {
  console.log('\nнаборы с ошибками:')
  for (const b of bad) console.log(`  - ${b.label}`)
}
process.exit(bad.length ? 1 : 0)


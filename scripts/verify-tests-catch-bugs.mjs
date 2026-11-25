// Проверка, что тесты ДЕЙСТВИТЕЛЬНО ловят баги.
//
// Тест, который проходит всегда, ничего не стоит. Здесь мы по очереди
// ломаем контракт — и убеждаемся, что хотя бы один тест падает. Если после
// поломки всё остаётся зелёным, значит тесты не проверяют то, что заявлено.

import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const FORGE = join(process.env.TEMP, 'foundry-bin', 'forge.exe')
const SRC = 'contracts/SementsulV2.sol'
const V3 = 'contracts/SementsulV3.sol'

const mutations = [
  {
    name: 'комиссия не взимается (fee = 0 в проверке k)',
    file: SRC,
    find: 'uint256 balance0Adjusted = balance0 * FEE_DENOMINATOR - amount0In * fee;',
    replace: 'uint256 balance0Adjusted = balance0 * FEE_DENOMINATOR;',
  },
  {
    name: 'резервы не обновляются после swap',
    file: SRC,
    find: 'reserve0 = uint112(balance0);',
    replace: 'reserve0 = uint112(balance0 > 0 ? balance0 - 1 : 0);',
  },
  {
    name: 'MINIMUM_LIQUIDITY не блокируется',
    file: SRC,
    find: '_mint(address(0), MINIMUM_LIQUIDITY);',
    replace: '_mint(to, MINIMUM_LIQUIDITY);',
  },
  {
    name: 'V3: mint берёт меньше токенов, чем нужно',
    file: V3,
    find: "require(IERC20(token0).transferFrom(msg.sender, address(this), amount0), 'Sementsul: TF_0');",
    replace: "require(IERC20(token0).transferFrom(msg.sender, address(this), amount0 / 2), 'Sementsul: TF_0');",
  },
  {
    name: 'V3: защита от JIT отключена (комиссия сразу доступна)',
    file: V3,
    find: 'uint64 delay = _jitDelay();',
    replace: 'uint64 delay = 0;',
  },
  {
    name: 'V3: снятие ликвидности не сжигает неотлежавшие комиссии',
    file: V3,
    find: 'if (liquidityDelta < 0 && (position.pending0 > 0 || position.pending1 > 0)) {',
    replace: 'if (false) {',
  },
  {
    name: 'V3: срок вестинга не проверяется (отлежавшееся выдаётся сразу)',
    file: V3,
    find: 'if (v != 0 && block.number >= v) {',
    replace: 'if (v != 0) {',
  },
  {
    // Соль без комиссии: пулы разных тиров одной пары претендуют на один
    // адрес CREATE2, и второй createPool падает — вместо четырёх пулов
    // получается один.
    name: 'V3: соль пула не включает тир комиссии',
    file: V3,
    find: 'salt: keccak256(abi.encode(token0, token1, _fee))',
    replace: 'salt: keccak256(abi.encode(token0, token1))',
  },
  {
    // Привязка задержки к ставке исчезает: все тиры получают один минимум.
    name: 'V3: задержка JIT не зависит от тира',
    file: V3,
    find: 'uint256 d = 150 + uint256(_fee) * 2;',
    replace: 'uint256 d = 150;',
  },
  {
    // Пул записывается в тир 0: getPool(t0, t1, fee) возвращает пустой адрес,
    // и индексатор пул не находит.
    name: 'V3: getPool записывает пул не в тот тир',
    file: V3,
    find: 'getPool[token0][token1][_fee] = pool;',
    replace: 'getPool[token0][token1][0] = pool;',
  },
]

// Разбираем ИТОГОВУЮ строку прогона.
//
// Наивный поиск первого «N failed» ловит строку первого же набора
// («Suite result: ok. 5 passed; 0 failed») и всегда даёт ноль — из-за этого
// скрипт раньше рапортовал «пропущено» даже когда тесты падали. Берём
// последнее совпадение по всему выводу.
function parseCounts(out) {
  const failedAll = [...out.matchAll(/(\d+)\s+failed/g)].map((m) => Number(m[1]))
  const passedAll = [...out.matchAll(/(\d+)\s+passed/g)].map((m) => Number(m[1]))
  return {
    failed: failedAll.length ? failedAll[failedAll.length - 1] : 0,
    passed: passedAll.length ? passedAll[passedAll.length - 1] : 0,
    raw: out,
  }
}

function runTests() {
  try {
    const out = execFileSync(FORGE, ['test'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    })
    return parseCounts(out)
  } catch (e) {
    const out = String(e.stdout ?? '') + String(e.stderr ?? '')
    return parseCounts(out)
  }
}

console.log('=== проверка, что тесты ловят поломки ===\n')

// Защита от прошлого прерывания.
//
// Восстановление идёт в finally, но если процесс убили (Ctrl+C, закрыли
// терминал), finally не выполнится и контракт останется сломанным. Тогда
// следующий коммит мог бы унести в репозиторий испорченный код. Поэтому при
// старте восстанавливаем всё, что осталось, и говорим об этом прямо.
for (const f of [SRC, V3]) {
  const leftover = f + '.bak'
  if (existsSync(leftover)) {
    copyFileSync(leftover, f)
    unlinkSync(leftover)
    console.log(`ВОССТАНОВЛЕН из .bak после прерывания: ${f}`)
  }
}

// Убираем за собой и при аварийном завершении.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const f of [SRC, V3]) {
      const leftover = f + '.bak'
      if (existsSync(leftover)) {
        copyFileSync(leftover, f)
        unlinkSync(leftover)
      }
    }
    console.log('\nпрервано — контракты восстановлены')
    process.exit(130)
  })
}

let caught = 0
let missed = 0

for (const m of mutations) {
  const backup = m.file + '.bak'
  copyFileSync(m.file, backup)

  const src = readFileSync(m.file, 'utf8')
  if (!src.includes(m.find)) {
    console.log(`ПРОПУСК: ${m.name}`)
    console.log(`  не найдено: ${m.find}`)
    unlinkSync(backup)
    continue
  }

  writeFileSync(m.file, src.replace(m.find, m.replace), 'utf8')

  let res
  try {
    res = runTests()
  } finally {
    copyFileSync(backup, m.file)
    unlinkSync(backup)
  }

  if (res.failed > 0) {
    caught++
    console.log(`ПОЙМАН: ${m.name}`)
    console.log(`  упало тестов: ${res.failed}`)
  } else {
    missed++
    console.log(`ПРОПУЩЕН: ${m.name} — тесты остались зелёными`)
    // Показываем итоговые строки: если сборка не удалась, «0 failed» ничего
    // не значит — тесты просто не запускались.
    const tail = res.raw.split('\n').filter((l) => /Error|error|failed|passed/.test(l)).slice(-4)
    tail.forEach((l) => console.log(`    ${l.trim()}`))
  }
}

console.log(`\nпоймано: ${caught}, пропущено: ${missed}`)
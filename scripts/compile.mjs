// Компиляция контрактов Sementsul.
//
// solc вызывается напрямую из Node, без Foundry/Hardhat: на машине их нет, а
// для проверки контрактов хватает компилятора и локальной EVM.
//
// Использование:
//   node scripts/compile.mjs           — собрать и записать артефакты
//   node scripts/compile.mjs --check   — только проверить, что компилируется

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOLC_PATH = process.env.SOLC_PATH ?? join(ROOT, '..', '_soltest', 'node_modules', 'solc', 'index.js')

const checkOnly = process.argv.includes('--check')

const solc = (await import(pathToFileURL(SOLC_PATH).href)).default

// Собираем все .sol из contracts/
const dir = join(ROOT, 'contracts')
const sources = {}
for (const f of readdirSync(dir).filter((f) => f.endsWith('.sol'))) {
  sources['contracts/' + f] = { content: readFileSync(join(dir, f), 'utf8') }
}

const input = {
  language: 'Solidity',
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // BSC поддерживает Shanghai (PUSH0), но не Cancun: иначе байткод
    // не примется сетью.
    evmVersion: 'shanghai',
    outputSelection: {
      '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'metadata'] },
    },
  },
}

const out = JSON.parse(solc.compile(JSON.stringify(input)))
const errors = (out.errors ?? []).filter((e) => e.severity === 'error')
const warnings = (out.errors ?? []).filter((e) => e.severity !== 'error')

for (const w of warnings) {
  console.log('warning:', w.formattedMessage?.split('\n')[0] ?? w.message)
}

if (errors.length) {
  for (const e of errors) console.error(e.formattedMessage ?? e.message)
  process.exit(1)
}

const artifacts = {}
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    const creation = c.evm.bytecode.object.length / 2
    // Лимит EIP-170 относится к РАЗВЁРНУТОМУ коду, а не к коду создания.
    // Здесь была ошибка: проверялся bytecode (код создания), который длиннее
    // развёрнутого на размер конструктора и констант. Из-за этого фабрика
    // V3 «не влезала» в лимит, хотя её развёрнутый код заметно меньше.
    const deployed = c.evm.deployedBytecode.object.length / 2
    console.log(
      `${name.padEnd(20)} ${String(creation).padStart(6)} байт создания, ` +
        `${String(deployed).padStart(6)} байт развёрнуто  (${file})`
    )
    artifacts[name] = {
      abi: c.abi,
      bytecode: '0x' + c.evm.bytecode.object,
      deployedBytecode: '0x' + c.evm.deployedBytecode.object,
      source: file,
    }
    // EIP-170: развёрнутый контракт не может превышать 24576 байт.
    if (deployed > 24576) {
      console.error(
        `ОШИБКА: ${name} больше лимита EIP-170: развёрнутый код ${deployed} > 24576 байт`
      )
      process.exit(1)
    }
    // Предупреждаем заранее, пока запас есть. Фабрика V3 вшивает в себя
    // creationCode пула, поэтому любая правка ПУЛА тоже раздувает ФАБРИКУ.
    // Когда запас станет нулевым, узнать об этом на деплое — поздно.
    const headroom = 24576 - deployed
    if (headroom < 1000) {
      console.warn(
        `ВНИМАНИЕ: у ${name} запас до лимита EIP-170 всего ${headroom} байт. ` +
          `Фабрика V3 содержит код пула, так что правка пула увеличивает и её.`
      )
    }
  }
}

if (!checkOnly) {
  mkdirSync(join(ROOT, 'src', 'contracts'), { recursive: true })
  writeFileSync(
    join(ROOT, 'src', 'contracts', 'artifacts.json'),
    JSON.stringify(artifacts, null, 2)
  )
  console.log(`\nартефакты записаны: src/contracts/artifacts.json`)
}

console.log('\nкомпиляция успешна')
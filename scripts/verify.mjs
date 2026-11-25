// Верификация контрактов на BscScan через Etherscan V2 API.
//
// BscScan перешёл на единый API Etherscan: BNB Chain там идёт как chainid=56,
// и старый api.bscscan.com/api больше не принимает ключи. Поэтому здесь один
// эндпоинт api.etherscan.io/v2/api с обязательным параметром chainid.
//
// Использование:
//   node scripts/verify.mjs            — верифицировать все четыре контракта
//   node scripts/verify.mjs --dry-run  — показать, что будет отправлено
//
// Верификация нужна не для галочки: без неё на BscScan виден только байткод,
// и проверить, что контракт делает именно то, что обещано, никто не может.

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')

const API = 'https://api.etherscan.io/v2/api'

function readEnv(name) {
  if (!existsSync(join(ROOT, '.env'))) return null
  const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'))
  return m ? m[1].trim() : null
}

const API_KEY = process.env.ETHERSCAN_API_KEY ?? readEnv('ETHERSCAN_API_KEY')
if (!API_KEY) {
  console.error('ошибка: не задан ETHERSCAN_API_KEY')
  process.exit(1)
}

// Адреса берём из записанного деплоя, а не из консоли: так исключена
// опечатка, из-за которой можно верифицировать чужой контракт.
const deploymentsSrc = readFileSync(join(ROOT, 'src', 'contracts', 'deployments.js'), 'utf8')
const json = deploymentsSrc.match(/export default ({[\s\S]*?})\s*$/)?.[1]
if (!json) {
  console.error('ошибка: не разобрал deployments.js')
  process.exit(1)
}
const deployments = JSON.parse(json)

const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))

// Оптимизатор должен совпадать с тем, чем контракт собирался, иначе
// верификация не сойдётся по байткоду и её отклонят.
const SETTINGS = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: 'shanghai',
}

/// Какие файлы нужны для сборки каждого контракта.
///
/// Контракты самодостаточны: интерфейсы лежат в interfaces.sol, внешних
/// библиотек нет. Но компилятору всё равно нужны ВСЕ импортируемые файлы —
/// он собирает их в один стандартный JSON-вход.
function sourcesFor() {
  const dir = join(ROOT, 'contracts')
  const out = {}
  for (const f of ['SementsulV2.sol', 'SementsulV3.sol', 'SementsulV3Router.sol', 'SementsulV3Math.sol', 'SementsulRouter.sol', 'SementsulToken.sol', 'interfaces.sol']) {
    const p = join(dir, f)
    if (existsSync(p)) out['contracts/' + f] = { content: readFileSync(p, 'utf8') }
  }
  return out
}

const CONTRACTS = [
  { name: 'SementsulFactory', address: deployments.factory, ctor: [Number(deployments.fee)] },
  { name: 'SementsulV3Factory', address: deployments.v3Factory, ctor: [deployments.v3FeeTiers, deployments.v3TickSpacingsForVerify ?? [1, 10, 50, 200], deployments.admin] },
  { name: 'SementsulRouter', address: deployments.router, ctor: [deployments.factory, deployments.wbnb] },
  { name: 'SementsulV3Router', address: deployments.v3Router, ctor: [deployments.v3Factory, deployments.wbnb] },
]

async function post(params) {
  // chainid обязан быть в СТРОКЕ ЗАПРОСА, а не в теле формы.
  //
  // Первая версия отправляла его вместе с остальными полями в теле, и API
  // отвечал «Missing or unsupported chainid parameter»: параметр просто не
  // доходил. Это неочевидно, потому что все остальные поля работают в теле.
  const { chainid, ...rest } = params
  const url = `${API}?chainid=${chainid ?? 56}`
  const body = new URLSearchParams({ ...rest, apikey: API_KEY })
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  return await res.json()
}

/// ethers/viem-подобных аргументов конструктора здесь нет, а тянуть
/// зависимость ради одной строки незачем. Кодируем через viem, он уже есть.
async function encodeCtor(types, values) {
  const { encodeAbiParameters } = await import('viem')
  const map = (t, v) => {
    if (t === 'uint24') return BigInt(v)
    if (t === 'int24') return BigInt(v)
    if (t === 'uint24[]') return v.map((x) => BigInt(x))
    if (t === 'int24[]') return v.map((x) => BigInt(x))
    if (t === 'address') return v
    if (t === 'uint256') return BigInt(v)
    return v
  }
  return encodeAbiParameters(types.map((t) => ({ type: t })), values.map((v, i) => map(types[i], v)))
}

async function main() {
  console.log('=== верификация на BscScan (Etherscan V2, chainid 56) ===\n')

  const results = []

  for (const c of CONTRACTS) {
    const art = artifacts[c.name]
    if (!art) {
      console.log(`${c.name}: НЕТ артефакта, пропуск`)
      continue
    }
    if (!c.address) {
      console.log(`${c.name}: НЕТ адреса в деплое, пропуск`)
      continue
    }

    // Первый аргумент конструктора у фабрики V3 — массив uint24, второй —
    // массив int24, третий — адрес. Передаём явные типы, а не угадываем их
    // по значениям: массив из BigInt неотличим от массива чисел.
    const ctorTypes =
      c.name === 'SementsulV3Factory'
        ? ['uint24[]', 'int24[]', 'address']
        : c.name === 'SementsulFactory'
          ? ['uint24']
          : ['address', 'address']

    let ctorArgsHex = ''
    try {
      if (c.ctor.length) {
        ctorArgsHex = (await encodeCtor(ctorTypes, c.ctor)).slice(2)
      }
    } catch (e) {
      console.log(`${c.name}: не смог закодировать аргументы конструктора — ${e.message}`)
      continue
    }

    const params = {
      module: 'contract',
      action: 'verifysourcecode',
      chainid: '56',
      contractaddress: c.address,
      sourceCode: JSON.stringify({
        language: 'Solidity',
        sources: sourcesFor(),
        settings: SETTINGS,
      }),
      codeformat: 'solidity-standard-json-input',
      contractname: `${art.source}:${c.name}`,
      compilerversion: 'v0.8.24+commit.e11b9ed9',
      constructorArguements: ctorArgsHex,
    }

    console.log(`${c.name}  ${c.address}`)
    if (dryRun) {
      const kb = Math.round(params.sourceCode.length / 1024)
      console.log(`  [dry-run] исходников ${kb} КБ, аргументы ${ctorArgsHex.length / 2} байт, контракт ${params.contractname}`)
      results.push({ name: c.name, status: 'dry-run' })
      continue
    }

    const r = await post(params)
    if (r.status === '1') {
      console.log(`  отправлено, GUID: ${r.result}`)
      results.push({ name: c.name, status: 'sent', guid: r.result })
    } else {
      // «Already Verified» — не ошибка: повторный запуск скрипта на уже
      // проверенных контрактах должен завершаться спокойно.
      const msg = String(r.result ?? r.message)
      if (/already verified/i.test(msg)) {
        console.log('  уже верифицирован')
        results.push({ name: c.name, status: 'already' })
      } else {
        console.log(`  ОТКАЗ: ${msg}`)
        results.push({ name: c.name, status: 'error', msg })
      }
    }
  }

  if (dryRun) {
    console.log('\n--dry-run: ничего не отправлено. Запустите без флага.')
    return
  }

  // Проверяем результат: Etherscan обрабатывает верификацию асинхронно.
  console.log('\n=== проверка результата (до 2 минут) ===\n')
  for (const r of results) {
    if (!r.guid) continue
    let ok = false
    for (let i = 0; i < 24; i++) {
      const s = await post({ module: 'contract', action: 'checkverifystatus', chainid: '56', guid: r.guid })
      const txt = String(s.result ?? '')
      if (/pass/i.test(txt) || /success/i.test(txt) || /already verified/i.test(txt)) {
        ok = true
        break
      }
      if (/fail/i.test(txt)) {
        console.log(`  ${r.name}: НЕ ПРОШЛО — ${txt.slice(0, 200)}`)
        break
      }
      await new Promise((res) => setTimeout(res, 5000))
    }
    if (ok) console.log(`  ${r.name}: верифицирован`)
  }
}

main().catch((e) => {
  console.error('ошибка:', e.message)
  process.exit(1)
})
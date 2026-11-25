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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
// В автозапуске (GitHub Actions) незачем каждый раз переспрашивать BscScan про
// контракты, которые уже верифицированы: это лишние запросы к бесплатному
// тарифу, где действует лимит 1 запрос в секунду. Флаг проверяет статус
// заранее и отправляет только те, что ещё не верифицированы.
const onlyUnverified = process.argv.includes('--only-unverified')

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
// Импортируем модуль деплоя, а не разбираем его регэкспом.
//
// Прежняя версия вырезала объект регуляркой и гоняла через JSON.parse. Это
// ломалось, как только в файле появлялся комментарий: JSON их не допускает.
// Импорт работает с настоящим JavaScript и не зависит от форматирования.
const { default: deployments } = await import(pathToFileURL(join(ROOT, 'src', 'contracts', 'deployments.js')).href)

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
  // Токен верифицируется тем же способом. Его может не быть — тогда строка
  // просто пропускается: биржа работает и без выпущенного SEM.
  {
    name: 'SementsulToken',
    address: deployments.token,
    ctor: [deployments.tokenRecipient, deployments.tokenSupply],
  },
  // Пары создаются фабрикой через create2 из того же байткода, что в
  // артефактах, и конструктор у них без аргументов (factory = msg.sender).
  // Поэтому любую пару можно верифицировать как contracts/SementsulV2.sol:SementsulPair.
  // Адреса подтягиваются из фабрики ниже, в pairContracts().
  ...(await pairContracts()),
  ...(await v3PoolContracts()),
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

// Пары, созданные фабрикой V2.
//
// Фабрика хранит их в allPairs и отдаёт по индексу allPairs(i). Читаем до
// первого отказа, а не по фиксированному списку: владелец может создать
// новую пару, и скрипт должен её подхватить без правки кода.
//
// Аргументов конструктора у пары нет: factory берётся из msg.sender, а
// токены приходят отдельным вызовом initialize. Поэтому ctor всегда пустой.
async function pairContracts() {
  if (!deployments.factory) return []

  const rpc = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'
  const client = createPublicClient({ chain: bsc, transport: http(rpc) })
  const abi = artifacts.SementsulFactory.abi

  const pairs = []
  for (let i = 0; i < 50; i++) {
    try {
      const addr = await client.readContract({
        address: deployments.factory,
        abi,
        functionName: 'allPairs',
        args: [BigInt(i)],
      })
      if (!addr || addr === '0x0000000000000000000000000000000000000000') break
      pairs.push({ name: `SementsulPair#${i}`, artifact: 'SementsulPair', address: addr, ctor: [] })
    } catch {
      // allPairs(i) за пределами массива — это конец списка, не ошибка.
      break
    }
  }

  if (pairs.length) {
    console.log(`пар в фабрике V2: ${pairs.length}`)
  }
  return pairs
}

// Пулы V3. Перечисляются так же, как пары V2, но через свой счётчик:
// allPoolsLength() даёт количество, allPools(i) — адрес.
//
// Конструктор без аргументов: пул создаётся через create2 и получает токены,
// комиссию и шаг тика вызовом initialize. Соль включает комиссию, поэтому
// пулы разных тиров одной пары — разные адреса.
async function v3PoolContracts() {
  if (!deployments.v3Factory) return []

  const rpc = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'
  const client = createPublicClient({ chain: bsc, transport: http(rpc) })
  const abi = artifacts.SementsulV3Factory.abi

  let count = 0n
  try {
    count = await client.readContract({
      address: deployments.v3Factory,
      abi,
      functionName: 'allPoolsLength',
    })
  } catch {
    return []
  }

  const pools = []
  for (let i = 0n; i < count; i++) {
    try {
      const addr = await client.readContract({
        address: deployments.v3Factory,
        abi,
        functionName: 'allPools',
        args: [i],
      })
      if (!addr || addr === '0x0000000000000000000000000000000000000000') continue
      pools.push({ name: `SementsulV3Pool#${i}`, artifact: 'SementsulV3Pool', address: addr, ctor: [] })
    } catch {
      // Один битый индекс не должен срывать верификацию остальных.
      continue
    }
  }

  if (pools.length) {
    console.log(`пулов в фабрике V3: ${pools.length}`)
  }
  return pools
}

async function main() {
  console.log('=== верификация на BscScan (Etherscan V2, chainid 56) ===\n')

  const results = []

  for (const c of CONTRACTS) {
    const art = artifacts[c.artifact ?? c.name]
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
    // У пар и пулов V3 конструктор без аргументов: и те и другие создаются
    // фабрикой через create2 и получают параметры отдельным initialize.
    const ctorTypes =
      c.artifact === 'SementsulPair' || c.artifact === 'SementsulV3Pool'
        ? []
        : c.name === 'SementsulV3Factory'
        ? ['uint24[]', 'int24[]', 'address']
        : c.name === 'SementsulFactory'
          ? ['uint24']
          : c.name === 'SementsulToken'
            ? ['address', 'uint256']
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
      contractname: `${art.source}:${c.artifact ?? c.name}`,
      compilerversion: 'v0.8.24+commit.e11b9ed9',
      constructorArguements: ctorArgsHex,
    }

    console.log(`${c.name}  ${c.address}`)

    // В режиме автозапуска сначала спрашиваем, не верифицирован ли уже.
    // getSourceCode возвращает пустой SourceCode, если контракт не проверен.
    if (onlyUnverified && !dryRun) {
      const chk = await post({
        module: 'contract',
        action: 'getsourcecode',
        chainid: '56',
        address: c.address,
      })
      const src = chk.result?.[0]?.SourceCode ?? ''
      if (src.length > 100) {
        console.log('  уже верифицирован')
        results.push({ name: c.name, status: 'already' })
        continue
      }
    }
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
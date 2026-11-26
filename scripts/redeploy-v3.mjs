// Передеплой ТОЛЬКО V3: фабрика и роутер.
//
// Зачем отдельный скрипт, а не scripts/deploy.mjs.
//
// Правка дефекта «запертая позиция» меняет код пула, пул разворачивается
// фабрикой через create2, значит нужны новые фабрика и роутер (роутер хранит
// адрес фабрики как immutable). V2, токен и пару SEM/WBNB передеплоивать не
// нужно и вредно: токен имеет фиксированное предложение без владельца, а его
// адрес зашит в пару и в интерфейс.
//
// scripts/deploy.mjs разворачивает все четыре контракта сразу и перезаписывает
// src/contracts/deployments.js целиком — то есть стёр бы адрес токена, пары и
// старого пула. Поэтому здесь: только два контракта, и адреса вписываются в
// существующий файл точечно.
//
// Отправка идёт через приватный RPC Pancake: транзакция не попадает в
// публичный мемпул и не может быть перехвачена.
//
// Использование:
//   node scripts/redeploy-v3.mjs --dry-run
//   node scripts/redeploy-v3.mjs
//
// Ключ берётся из DEPLOYER_KEY или из .env и нигде не печатается.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, createWalletClient, http, defineChain, encodeAbiParameters } from 'viem'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const RPC_READ = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'
const RPC_PRIVATE = 'https://bscrpc.pancakeswap.finance'

// Потолок газа на транзакцию у этого RPC — 16777216 (2^24). Ставим с запасом,
// но ниже потолка: иначе узел отклонит транзакцию ещё до отправки.
const GAS = 7_000_000n

const bsc = defineChain({
  id: 56,
  name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [RPC_READ] } },
})

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

// Тиры те же, что в текущем деплое: менять их при переезде нельзя, иначе пул
// WBNB/USDT (тир 500) окажется на фабрике, где такого тира нет.
const V3_FEES = [50n, 500n, 2500n, 10000n]
const V3_SPACINGS = [1n, 10n, 50n, 200n]

function envFromFile(name) {
  if (!existsSync(join(ROOT, '.env'))) return null
  const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'))
  return m ? m[1].trim() : null
}

function ctorParams(inputs) {
  return inputs.map((i) => ({ name: i.name ?? '', type: i.type }))
}

function normalizeArg(value, type) {
  if (type.endsWith('[]')) {
    const inner = type.slice(0, -2)
    if (!Array.isArray(value)) throw new Error(`${type}: ожидался массив`)
    return value.map((v) => normalizeArg(v, inner))
  }
  if (type === 'address') return value
  if (type === 'bool') return Boolean(value)
  if (type.startsWith('uint') || type.startsWith('int')) return BigInt(value)
  if (type === 'string' || type === 'bytes') return value
  throw new Error(`тип ${type} не поддержан`)
}

// Кодируем аргументы конструктора ровно тем же кодировщиком, что читает ABI:
// у фабрики V3 два динамических массива, ручное «слово на аргумент» дало бы
// битую calldata и сожгло газ впустую.
function encodeCtor(name, values) {
  const art = artifacts[name]
  const inputs = art.abi.find((x) => x.type === 'constructor')?.inputs ?? []
  if (inputs.length !== values.length) {
    throw new Error(`${name}: ожидалось ${inputs.length} аргументов, передано ${values.length}`)
  }
  const encoded =
    inputs.length === 0
      ? ''
      : encodeAbiParameters(
          ctorParams(inputs),
          values.map((v, i) => normalizeArg(v, inputs[i].type))
        ).slice(2)
  return art.bytecode + encoded
}

async function main() {
  const privateKey = process.env.DEPLOYER_KEY ?? envFromFile('DEPLOYER_KEY')
  if (!privateKey) throw new Error('не задан DEPLOYER_KEY (в окружении или в .env)')

  const account = privateKeyToAccount(privateKey)
  const read = createPublicClient({ chain: bsc, transport: http(RPC_READ) })
  const wallet = createWalletClient({ account, chain: bsc, transport: http(RPC_PRIVATE) })

  console.log('=== передеплой V3 (фабрика + роутер) ===')
  console.log('деплоер:', account.address)
  console.log('RPC отправки:', RPC_PRIVATE)
  console.log('')

  // Администратор фабрики: управляет только задержкой JIT и штрафом за
  // разворот. Ни вывода средств, ни изменения комиссии у него нет.
  const admin = account.address

  const factoryData = encodeCtor('SementsulV3Factory', [V3_FEES, V3_SPACINGS, admin])
  const factorySize = (factoryData.length - 2) / 2
  console.log('фабрика V3: байткод + аргументы', factorySize, 'байт')

  const balance = await read.getBalance({ address: account.address })
  const gasPrice = await read.getGasPrice()
  const estimate = GAS * 2n * gasPrice
  console.log('баланс деплоера:', Number(balance) / 1e18, 'BNB')
  console.log('оценка стоимости:', Number(estimate) / 1e18, 'BNB')
  if (balance < estimate) throw new Error('недостаточно BNB на деплое')

  if (dryRun) {
    console.log('')
    console.log('--- --dry-run: транзакции не отправляются ---')
    console.log('будет развёрнуто:')
    console.log('  1. SementsulV3Factory  тиры:', V3_FEES.join(', '))
    console.log('  2. SementsulV3Router   (получит адрес новой фабрики)')
    console.log('')
    console.log('адрес пула WBNB/USDT изменится: фабрика разворачивает пул через')
    console.log('create2 с солью от пары и тира, а адрес фабрики входит в соль.')
    return
  }

  let nonce = await read.getTransactionCount({ address: account.address, blockTag: 'pending' })

  console.log('')
  console.log('1/2 фабрика V3...')
  const fHash = await wallet.sendTransaction({
    account,
    chain: bsc,
    data: factoryData,
    nonce: nonce++,
    gas: GAS,
    gasPrice,
  })
  console.log('  отправлено:', fHash)
  const fReceipt = await waitOk(read, fHash, 'фабрика')
  const v3Factory = fReceipt.contractAddress
  console.log('  адрес:', v3Factory, '(газ', fReceipt.gasUsed + ')')

  const routerData = encodeCtor('SementsulV3Router', [v3Factory, WBNB])
  console.log('')
  console.log('2/2 роутер V3...')
  const rHash = await wallet.sendTransaction({
    account,
    chain: bsc,
    data: routerData,
    nonce: nonce++,
    gas: GAS,
    gasPrice,
  })
  console.log('  отправлено:', rHash)
  const rReceipt = await waitOk(read, rHash, 'роутер')
  const v3Router = rReceipt.contractAddress
  console.log('  адрес:', v3Router, '(газ', rReceipt.gasUsed + ')')

  // Проверяем, что роутер действительно смотрит на новую фабрику: immutable
  // читается публичным геттером, и это единственная дешёвая проверка, что
  // аргументы конструктора не перепутаны местами.
  const factoryInRouter = await read.readContract({
    address: v3Router,
    abi: artifacts.SementsulV3Router.abi,
    functionName: 'FACTORY',
  })
  if (factoryInRouter.toLowerCase() !== v3Factory.toLowerCase()) {
    throw new Error(`роутер указывает на ${factoryInRouter}, а фабрика ${v3Factory}`)
  }
  console.log('')
  console.log('проверка: роутер.FACTORY() == адрес новой фабрики — ок')

  // Адреса вписываем в существующий файл точечно: полная перезапись стёрла бы
  // токен, пару SEM/WBNB и старый пул, которые этот скрипт не трогает.
  const path = join(ROOT, 'src', 'contracts', 'deployments.js')
  let src = readFileSync(path, 'utf8')
  const before = src

  src = src.replace(/("v3Factory":\s*")[^"]+(")/, `$1${v3Factory}$2`)
  src = src.replace(/("v3Router":\s*")[^"]+(")/, `$1${v3Router}$2`)

  // Поле wbnbUsdtV3Pool намеренно не трогаем: старый пул ещё существует, и в
  // нём лежит ликвидность, которую надо вывести. Новый адрес впишет
  // scripts/create-pool-v3.mjs после создания пула.

  if (src === before) throw new Error('deployments.js не изменился: шаблон замены не совпал')
  writeFileSync(path, src)
  console.log('')
  console.log('адреса записаны в src/contracts/deployments.js')
  console.log('  v3Factory:', v3Factory)
  console.log('  v3Router: ', v3Router)
  console.log('')
  console.log('дальше: node scripts/create-pool-v3.mjs — создаст новый пул WBNB/USDT')
}

async function waitOk(client, hash, what) {
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${what}: транзакция отменена`)
  if (!receipt.contractAddress) throw new Error(`${what}: в чеке нет адреса контракта`)
  return receipt
}

main().catch((e) => {
  console.error('\nошибка:', e.shortMessage ?? e.message)
  process.exit(1)
})
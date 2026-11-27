// Деплой трёх ДОПОЛНИТЕЛЬНЫХ контрактов: квотер, роутер со стандартным ABI,
// адаптер вида Uniswap.
//
// ЧТО НЕ ТРОГАЕТСЯ
// ----------------
// Пул, фабрика, старый роутер и токены остаются как есть. Это добавление,
// а не передеплой: новый роутер получает тот же адрес фабрики, поэтому
// видит существующие пулы автоматически, а ликвидность живёт в пуле и
// никуда не переносится.
//
// ПОРЯДОК
// -------
//   1. Квотер(factory, wbnb)
//   2. Роутер(factory, wbnb)
//   3. Адаптер(pool) — для нашего пула WBNB/USDT 0.05%
//
// Адреса вписываются в src/contracts/deployments.js ТОЧЕЧНО: остальные
// поля не перезаписываются. Полный deploy.mjs стёр бы адрес токена, пары
// и старого пула.
//
// Отправка через приватный RPC Pancake: транзакция не попадает в публичный
// мемпул и не может быть перехвачена.
//
// Использование:
//   node scripts/deploy-extras.mjs --dry-run
//   node scripts/deploy-extras.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, createWalletClient, http, defineChain } from 'viem'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const V3_FACTORY = '0xc0B597BeE57bba0aaE2CE9E73e83217331a24dD9'
const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'

const RPC_READ = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'
const RPC_PRIVATE = 'https://bscrpc.pancakeswap.finance'

// Потолок газа у этого RPC — 16777216 (2^24). Ставим с запасом, но ниже.
const GAS = 4_000_000n

const bsc = defineChain({
  id: 56,
  name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [RPC_READ] } },
})

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')

function envFromFile(name) {
  if (!existsSync(join(ROOT, '.env'))) return null
  const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'))
  return m ? m[1].trim() : null
}

function needArtifact(name) {
  const a = artifacts[name]
  if (!a) throw new Error(`нет артефакта ${name} — сначала npm run compile`)
  return a
}

const quoterArt = needArtifact('SementsulV3Quoter')
const routerArt = needArtifact('SementsulSwapRouter')
const adapterArt = needArtifact('SementsulPoolViewAdapter')

console.log('=== ДЕПЛОЙ ДОПОЛНИТЕЛЬНЫХ КОНТРАКТОВ ===')
console.log('')
console.log('  НЕ трогаем:')
console.log('    пул      ', POOL)
console.log('    фабрика  ', V3_FACTORY)
console.log('    старый роутер 0xf98b7f4effb34dae1f785010ecf71ff796e7fdd1')
console.log('')
console.log('  Деплоим:')
console.log('    1. SementsulV3Quoter        (factory, wbnb)')
console.log('    2. SementsulSwapRouter      (factory, wbnb)')
console.log('    3. SementsulPoolViewAdapter (pool)')
console.log('')

const publicClient = createPublicClient({ chain: bsc, transport: http(RPC_READ) })

// Ключ: сначала окружение, потом .env. Никогда не печатаем.
const pk = process.env.DEPLOYER_KEY ?? envFromFile('DEPLOYER_KEY')
if (!pk) throw new Error('нет DEPLOYER_KEY ни в окружении, ни в .env')
const key = pk.startsWith('0x') ? pk : `0x${pk}`
const account = privateKeyToAccount(key)

const balance = await publicClient.getBalance({ address: account.address })
const gasPrice = await publicClient.getGasPrice()
console.log('  деплоер:', account.address)
console.log('  баланс :', Number(balance) / 1e18, 'BNB')
console.log('  газ    :', Number(gasPrice) / 1e9, 'gwei')
console.log('')

// Три деплоя подряд, каждый ~200-600k газа. Считаем, хватает ли.
const roughNeed = 3n * 700_000n * gasPrice
console.log('  грубая оценка расхода:', Number(roughNeed) / 1e18, 'BNB')
if (balance < roughNeed) {
  console.log('')
  console.log('  ВНИМАНИЕ: баланса может не хватить. Пополните адрес деплоера.')
}
console.log('')

if (dryRun) {
  console.log('  --dry-run: ничего не отправляем.')
  console.log('')
  console.log('  Чтобы выполнить по-настоящему: node scripts/deploy-extras.mjs')
  process.exit(0)
}

const walletClient = createWalletClient({
  account,
  chain: bsc,
  transport: http(RPC_PRIVATE),
})

async function deploy(label, art, constructorArgs) {
  console.log(`  --- ${label} ---`)
  const hash = await walletClient.deployContract({
    abi: art.abi,
    bytecode: art.bytecode,
    args: constructorArgs,
    gas: GAS,
  })
  console.log('    tx:', hash)
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 180_000 })
  if (!receipt.contractAddress) throw new Error(`${label}: нет адреса в квитанции`)
  console.log('    адрес:', receipt.contractAddress)
  console.log('    блок :', receipt.blockNumber.toString(), ' газ:', receipt.gasUsed.toString())
  console.log('')
  return receipt.contractAddress
}

const quoterAddr = await deploy('SementsulV3Quoter', quoterArt, [V3_FACTORY, WBNB])
const routerAddr = await deploy('SementsulSwapRouter', routerArt, [V3_FACTORY, WBNB])
const adapterAddr = await deploy('SementsulPoolViewAdapter', adapterArt, [POOL])

// --- Проверки сразу после деплоя ---

console.log('=== ПРОВЕРКА НА ЦЕПИ ===')

const qFactory = await publicClient.readContract({
  address: quoterAddr,
  abi: quoterArt.abi,
  functionName: 'FACTORY',
})
const rFactory = await publicClient.readContract({
  address: routerAddr,
  abi: routerArt.abi,
  functionName: 'FACTORY',
})
const aPool = await publicClient.readContract({
  address: adapterAddr,
  abi: adapterArt.abi,
  functionName: 'POOL',
})

console.log('  квотер.FACTORY =', qFactory, qFactory.toLowerCase() === V3_FACTORY.toLowerCase() ? 'OK' : 'НЕ СОВПАЛО')
console.log('  роутер.FACTORY =', rFactory, rFactory.toLowerCase() === V3_FACTORY.toLowerCase() ? 'OK' : 'НЕ СОВПАЛО')
console.log('  адаптер.POOL   =', aPool, aPool.toLowerCase() === POOL.toLowerCase() ? 'OK' : 'НЕ СОВПАЛО')
console.log('')

// Селекторы: главное, ради чего деплоился роутер.
const { toFunctionSelector } = await import('viem')
const checks = [
  ['exactInputSingle', 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))', '0x414bf389'],
  ['exactInput', 'exactInput((bytes,address,uint256,uint256,uint256))', '0xc04b8d59'],
  ['exactOutputSingle', 'exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))', '0xdb3e2198'],
  ['exactOutput', 'exactOutput((bytes,address,uint256,uint256,uint256))', '0xf28c0498'],
]
console.log('  селекторы роутера (должны совпасть с Uniswap):')
for (const [name, sig, expect] of checks) {
  const got = toFunctionSelector('function ' + sig)
  console.log(`    ${name.padEnd(20)} ${got}  ${got === expect ? 'OK' : 'ОШИБКА, ждали ' + expect}`)
}
console.log('')

// --- Записываем адреса точечно ---

const depPath = join(ROOT, 'src', 'contracts', 'deployments.js')
let src = readFileSync(depPath, 'utf8')

function setField(source, key, value) {
  const re = new RegExp(`(\\s*"${key}":\\s*)"([^"]*)"`)
  if (re.test(source)) return source.replace(re, `$1"${value}"`)
  // Поля нет — вставляем после v3Router.
  return source.replace(/(\s*"v3Router":\s*"[^"]*",)/, `$1\n  "${key}": "${value}",`)
}

src = setField(src, 'v3Quoter', quoterAddr.toLowerCase())
src = setField(src, 'v3RouterStd', routerAddr.toLowerCase())
src = setField(src, 'poolViewAdapter', adapterAddr.toLowerCase())
writeFileSync(depPath, src, 'utf8')

console.log('  адреса записаны в src/contracts/deployments.js:')
console.log('    v3Quoter        :', quoterAddr.toLowerCase())
console.log('    v3RouterStd     :', routerAddr.toLowerCase())
console.log('    poolViewAdapter :', adapterAddr.toLowerCase())
console.log('')
console.log('=== ГОТОВО ===')
console.log('')
console.log('  Дальше:')
console.log('    npm run build      — пересобрать фронтенд')
console.log('    проверить quote:   node scripts/verify-new-contracts.mjs')
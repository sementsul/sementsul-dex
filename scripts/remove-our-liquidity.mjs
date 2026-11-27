// Снятие нашей позиции из пула и перевод средств на кошелёк бота.
//
// Задача: убрать ликвидность, которую мы держим, и отдать USDT+WBNB боту,
// чтобы он дальше распоряжался ими сам.
//
// ПОЧЕМУ НЕ ПРОСТО burn
// --------------------
// burn() снимает ликвидность и сразу переводит освободившиеся токены. Но
// комиссии он не начисляет: если в позиции накопилось начисленное, при
// полном снятии незрелая часть (pending) обнуляется в _modifyPosition —
// сгорает. Поэтому порядок такой:
//
//   1. collect() — переносит начисленное в pending и ставит vestBlock;
//   2. ждём jitDelayBlocks (1150 для тира 500);
//   3. collect() снова — забирает созревшее;
//   4. burn() — снимает ликвидность.
//
// Если начисленного нет (частый случай: пул молодой, свопов мало), шаги 1-3
// ничего не дают, но и не вредят: первый collect просто выставит vestBlock=0
// и вернёт нули. Проверять это надо заранее симуляцией, чтобы не жечь газ
// впустую.
//
// ГАЗ
// ---
// Платится нативным BNB с адреса владельца позиции. WBNB для газа не
// годится. Скрипт останавливается до первой транзакции, если BNB мало.
//
// Использование:
//   node scripts/remove-our-liquidity.mjs                      # только план
//   node scripts/remove-our-liquidity.mjs --send               # выполнить
//   node scripts/remove-our-liquidity.mjs --send --collect-only # только собрать комиссии
//
// Направление перевода задаётся отдельно (по умолчанию — на кошелёк бота).

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseEther,
  formatUnits,
  formatEther,
  keccak256,
  encodePacked,
  maxUint128,
  erc20Abi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const FACTORY = '0xc0b597bee57bba0aae2ce9e73e83217331a24dd9'
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

// Кошелёк бота: туда уходят средства, чтобы он добавил их через себя.
const DEFAULT_TO = '0x922598c9D529836b4b475cE74188D5EeFFb83a88'

// Границы нашей позиции. Проверены на цепи: ликвидность там есть.
const DEFAULT_LOWER = -63500
const DEFAULT_UPPER = -63090

// Приватный RPC минует публичный мемпул: снятие ликвидности видят
// сэндвич-боты, и в открытом мемпуле это повод для атаки.
const RPC_SEND = 'https://bscrpc.pancakeswap.finance'
const RPC_READ = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'

const args = process.argv.slice(2)
const SEND = args.includes('--send')
const COLLECT_ONLY = args.includes('--collect-only')

function arg(name, fallback = null) {
  const i = args.indexOf(name)
  if (i === -1) return fallback
  const v = args[i + 1]
  return v && !v.startsWith('--') ? v : fallback
}

const TO = arg('--to', DEFAULT_TO)
const LOWER = Number(arg('--lower', DEFAULT_LOWER))
const UPPER = Number(arg('--upper', DEFAULT_UPPER))

function env(name) {
  const raw = readFileSync(join(ROOT, '.env'), 'utf8')
  const m = raw.match(new RegExp('^' + name + '\\s*=\\s*(.*)$', 'm'))
  if (!m) throw new Error(`в .env нет ${name}`)
  const v = m[1].trim().replace(/^["']|["']$/g, '')
  return v.startsWith('0x') ? v : '0x' + v
}

const poolAbi = parseAbi([
  'function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount) returns (uint256, uint256)',
  'function burn(int24 tickLower, int24 tickUpper, uint128 amount) returns (uint256, uint256)',
  'function collect(address recipient, int24 tickLower, int24 tickUpper, uint128 amount0Requested, uint128 amount1Requested) returns (uint128, uint128)',
  'function positions(bytes32) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1, uint128 pending0, uint128 pending1, uint256 vestBlock)',
  'function slot0() view returns (uint160, int24, uint128, uint24, int24)',
])

const factoryAbi = parseAbi(['function jitDelayBlocks(uint24) view returns (uint32)'])

const account = privateKeyToAccount(env('RECEIVER_KEY'))
const pub = createPublicClient({ chain: bsc, transport: http(RPC_READ, { timeout: 30_000 }) })
const wallet = createWalletClient({ account, chain: bsc, transport: http(RPC_SEND, { timeout: 60_000 }) })

const key = keccak256(encodePacked(['address', 'int24', 'int24'], [account.address, LOWER, UPPER]))

const fmt0 = (v) => (Number(v) / 1e18).toFixed(6)
const fmt1 = (v) => (Number(v) / 1e18).toFixed(8)

// ---------- состояние ----------

const [pos, slot0, gasPrice, bnbBal] = await Promise.all([
  pub.readContract({ address: POOL, abi: poolAbi, functionName: 'positions', args: [key] }),
  pub.readContract({ address: POOL, abi: poolAbi, functionName: 'slot0' }),
  pub.getGasPrice(),
  pub.getBalance({ address: account.address }),
])
const jit = await pub.readContract({
  address: FACTORY, abi: factoryAbi, functionName: 'jitDelayBlocks', args: [500],
})
const blockNow = await pub.getBlockNumber()

const [liq, , , owed0, owed1, pend0, pend1, vestBlock] = pos

console.log('=== ЧТО СНИМАЕМ ===')
console.log('  владелец :', account.address, '(ключ RECEIVER_KEY)')
console.log('  диапазон :', LOWER, '..', UPPER)
console.log('  ключ     :', key)
console.log('  ликвидность:', liq.toString())
console.log('  блок     :', blockNow.toString(), ' tick:', slot0[1])
console.log('')
console.log('  tokensOwed :', fmt0(owed0), 'USDT /', fmt1(owed1), 'WBNB')
console.log('  pending    :', fmt0(pend0), 'USDT /', fmt1(pend1), 'WBNB')
console.log('  vestBlock  :', vestBlock.toString())

if (liq === 0n) {
  console.log('\n  ОСТАНОВ: ликвидности в позиции нет — снимать нечего.')
  process.exit(1)
}

// Хватит ли газа?
//
// Раньше здесь стояла грубая оценка 1.2M газа на все транзакции, и она
// блокировала работу при реальной потребности в 320k: на кошельке было
// 0.0000326 BNB при «нужных» 0.00006. Считать надо фактически, а не на
// глаз — eth_estimateGas даёт точное число для конкретного вызова.
let gasEstimate = 0n
try {
  const g1 = await pub.estimateContractGas({
    address: POOL, abi: poolAbi, functionName: 'burn',
    args: [LOWER, UPPER, liq], account: account.address,
  })
  // Два перевода токенов боту — примерно по 60k, но оценим и их.
  gasEstimate = g1 + 60_000n * 2n
} catch (e) {
  // Не смогли оценить — берём заведомо достаточное число.
  console.log('  оценка газа не удалась:', String(e.shortMessage || e.message).slice(0, 100))
  gasEstimate = 350_000n
}
// Запас 30%: burn может выйти дороже при изменении состояния тиков.
const gasCost = (gasEstimate * gasPrice * 130n) / 100n
console.log('\n=== ГАЗ ===')
console.log('  BNB на счету :', formatEther(bnbBal))
console.log('  газа нужно  :', gasEstimate.toString(), '≈', formatEther(gasCost), 'BNB (+30%)')
console.log('  gasPrice    :', (Number(gasPrice) / 1e9).toFixed(4), 'gwei')
if (bnbBal < gasCost) {
  console.log('\n  ОСТАНОВ: нативного BNB не хватает на газ.')
  console.log('  WBNB для газа не годится, пополните именно BNB.')
  console.log('  не хватает:', formatEther(gasCost - bnbBal), 'BNB')
  process.exit(1)
}

// ---------- комиссии: есть ли что собирать ----------

// Симуляция collect показывает, сколько вернётся СЕЙЧАС. Первый вызов
// переводит начисленное в pending и ставит vestBlock — поэтому фактически
// он и определяет, есть ли смысл в вестинге.
let simOk = false
let sim0 = 0n
let sim1 = 0n
try {
  const res = await pub.simulateContract({
    address: POOL, abi: poolAbi, functionName: 'collect',
    args: [account.address, LOWER, UPPER, maxUint128, maxUint128],
    account: account.address,
  })
  ;[sim0, sim1] = res.result
  simOk = true
} catch (e) {
  console.log('\n  симуляция collect не удалась:', String(e.shortMessage || e.message).slice(0, 140))
}

console.log('\n=== КОМИССИИ ===')
if (simOk) {
  const usd = Number(sim0) / 1e18 + (Number(sim1) / 1e18) * 564
  console.log('  collect() вернёт сейчас:', fmt0(sim0), 'USDT /', fmt1(sim1), 'WBNB')
  console.log('  в долларах ≈ $' + usd.toFixed(4))
  if (usd < 0.01) {
    console.log('  вердикт: пыль. Вестинг не нужен — снимаем ликвидность сразу.')
  } else {
    console.log('  вердикт: сумма заметная — делаем collect, ждём', jit.toString(), 'блоков, collect, burn.')
  }
} else {
  console.log('  вердикт: неизвестно, считаем что собирать нечего.')
}

// ---------- план ----------

console.log('\n=== ПЛАН ===')
console.log('  1. burn(', LOWER, ',', UPPER, ',', liq.toString(), ')')
console.log('     → освободит USDT и WBNB, они придут на', account.address)
console.log('  2. перевести всё на', TO, '(кошелёк бота)')
if (simOk && Number(sim0) + Number(sim1) > 0) {
  console.log('  0. перед burn: collect + ожидание вестинга + collect')
}

if (!SEND) {
  console.log('\n  Это только план. Ничего не отправлено.')
  console.log('  Для выполнения: node scripts/remove-our-liquidity.mjs --send')
  process.exit(0)
}

// ---------- выполнение ----------

// Оценка «наружу»: burn переводит токены сам, поэтому approve не нужен.
async function sendAndWait(hash, label) {
  console.log(`  ${label}: ${hash}`)
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (r.status !== 'success') throw new Error(`${label} откатился`)
  console.log(`    ok, блок ${r.blockNumber}, газ ${r.gasUsed}`)
  return r
}

console.log('\n=== ВЫПОЛНЕНИЕ ===')

if (!COLLECT_ONLY && simOk && Number(sim0) + Number(sim1) > 0) {
  // Шаг 0а: перенести начисленное в pending.
  const h1 = await wallet.writeContract({
    address: POOL, abi: poolAbi, functionName: 'collect',
    args: [account.address, LOWER, UPPER, maxUint128, maxUint128],
  })
  await sendAndWait(h1, 'collect #1')
  // Шаг 0б: ждать вестинг.
  const target = (await pub.getBlockNumber()) + BigInt(jit) + 2n
  console.log('  ждём вестинг до блока', target.toString())
  for (;;) {
    const b = await pub.getBlockNumber()
    if (b >= target) break
    await new Promise((r) => setTimeout(r, 1500))
  }
  const h2 = await wallet.writeContract({
    address: POOL, abi: poolAbi, functionName: 'collect',
    args: [account.address, LOWER, UPPER, maxUint128, maxUint128],
  })
  await sendAndWait(h2, 'collect #2')
}

// Основное: снять ликвидность.
if (!COLLECT_ONLY) {
  const hb = await wallet.writeContract({
    address: POOL, abi: poolAbi, functionName: 'burn',
    args: [LOWER, UPPER, liq],
  })
  await sendAndWait(hb, 'burn')
}

// ---------- перевод боту ----------

const bal0 = await pub.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
const bal1 = await pub.readContract({ address: WBNB, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
console.log('\n  на счету после снятия:')
console.log('    USDT:', fmt0(bal0))
console.log('    WBNB:', fmt1(bal1))

for (const [token, amount, label] of [
  [USDT, bal0, 'USDT'],
  [WBNB, bal1, 'WBNB'],
]) {
  if (amount === 0n) {
    console.log(`  ${label}: 0 — пропускаем`)
    continue
  }
  const ht = await wallet.writeContract({
    address: token, abi: erc20Abi, functionName: 'transfer', args: [TO, amount],
  })
  await sendAndWait(ht, `transfer ${label}`)
}

console.log('\n=== ГОТОВО ===')
console.log('  средства на', TO)
console.log('  проверка: node scripts/check-our-position.mjs', TO, LOWER, UPPER)
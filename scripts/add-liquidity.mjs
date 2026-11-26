// Добавление ликвидности в пул WBNB/USDT с диапазоном вокруг текущей цены.
//
// Диапазон задаётся в процентах от текущей цены (±2% по умолчанию). Тики
// считаются от реального тика пула и выравниваются по шагу: контракт
// отвергает границы, не кратные tickSpacing, поэтому округляем наружу —
// нижнюю вниз, верхнюю вверх, чтобы диапазон не оказался уже заказанного.
//
// Почему наружу, а не к ближайшему: при округлении внутрь фактический
// диапазон становится уже, и позиция выходит за границы раньше, чем
// рассчитывал человек.
//
// ПОРЯДОК
// -------
//   1. approve USDT и WBNB роутеру пула (если ещё не дано);
//   2. pool.mint(owner, tickLower, tickUpper, liquidity).
//
// Ликвидность (liquidity) — не сумма токенов. Это величина L из формулы
// Uniswap V3; сколько именно токенов спишется, зависит от цены и границ.
// Поэтому L считается из желаемых сумм, а не задаётся на глаз.
//
// ГАЗ
// ---
// Платится нативным BNB. WBNB для газа не годится: это обычный ERC-20.
// Если BNB нет, скрипт останавливается до первой транзакции — иначе approve
// упадёт с непонятной ошибкой.
//
// Использование:
//   node scripts/add-liquidity.mjs --dry-run
//   node scripts/add-liquidity.mjs
//   node scripts/add-liquidity.mjs --pct 2 --usdt 200

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  formatEther,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const RPC_SEND = 'https://bscrpc.pancakeswap.finance'
const RPC_READ = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'

const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

const dryRun = process.argv.includes('--dry-run')

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : fallback
}

function readEnv(name) {
  if (!existsSync(join(ROOT, '.env'))) return null
  const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'))
  return m ? m[1].trim() : null
}

const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))
const { default: d } = await import(new URL('../src/contracts/deployments.js', import.meta.url).href)

const poolAbi = artifacts.SementsulV3Pool.abi
const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

const read = createPublicClient({ chain: bsc, transport: http(RPC_READ) })

const Q96 = 2n ** 96n

// log(1.0001) — шаг одного тика. Через него проценты переводятся в тики.
const LN_TICK = Math.log(1.0001)

function sqrtAtTick(tick) {
  return Math.pow(1.0001, tick / 2)
}

async function main() {
  const pct = Number(arg('--pct', '2'))
  const usdtArg = arg('--usdt')

  console.log(`=== ликвидность WBNB/USDT, диапазон ±${pct}% ===\n`)

  const pool = d.wbnbUsdtV3Pool
  if (!pool) {
    console.error('в deployments.js нет wbnbUsdtV3Pool')
    process.exit(1)
  }
  console.log('пул:', pool)

  // ---------- состояние пула ----------
  const slot0 = await read.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' })
  const sqrtPriceX96 = slot0[0]
  const tick = Number(slot0[1])
  const fee = Number(slot0[3])
  const spacing = Number(slot0[4])

  const price = (Number(sqrtPriceX96) / Number(Q96)) ** 2 // WBNB за 1 USDT
  const usdPerWbnb = 1 / price

  console.log('тик:      ', tick)
  console.log('шаг тика: ', spacing)
  console.log('комиссия: ', fee, `(${fee / 10000}%)`)
  console.log('1 WBNB =', usdPerWbnb.toFixed(2), 'USDT')

  // ---------- расчёт тиков ----------
  // Границы в тиках: tick ± log(1±pct/100)/log(1.0001).
  const dTicks = Math.log(1 + pct / 100) / LN_TICK
  const rawLower = tick - dTicks
  const rawUpper = tick + dTicks

  // Округляем наружу и выравниваем по шагу.
  let tickLower = Math.floor(rawLower / spacing) * spacing
  let tickUpper = Math.ceil(rawUpper / spacing) * spacing

  console.log('')
  console.log('диапазон (в тиках и в привычной цене за 1 WBNB):')
  // Цена в пуле — token1 за token0, то есть WBNB за 1 USDT. Привычная цена
  // «USDT за WBNB» — обратная величина. Из-за этого нижний тик соответствует
  // ВЕРХНЕЙ цене за WBNB, и наоборот: тик растёт, когда WBNB дешевеет.
  const usdAt = (t) => 1 / Math.pow(1.0001, t)
  console.log(`  тик ${tickLower}  ->  ${usdAt(tickLower).toFixed(2)} USDT за 1 WBNB   (верхняя цена)`)
  console.log(`  тик ${tick}  ->  ${usdAt(tick).toFixed(2)} USDT за 1 WBNB   (сейчас)`)
  console.log(`  тик ${tickUpper}  ->  ${usdAt(tickUpper).toFixed(2)} USDT за 1 WBNB   (нижняя цена)`)
  console.log(`  ширина: ${((Math.pow(1.0001, tickUpper) / Math.pow(1.0001, tickLower) - 1) * 100).toFixed(2)}%`)

  // ---------- балансы ----------
  const key = process.env.RECEIVER_KEY ?? readEnv('RECEIVER_KEY')
  if (!key) {
    console.error('\nнет RECEIVER_KEY в .env')
    process.exit(1)
  }
  const account = privateKeyToAccount(key.startsWith('0x') ? key : '0x' + key)

  const [bnb, wbnbBal, usdtBal] = await Promise.all([
    read.getBalance({ address: account.address }),
    read.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
    read.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
  ])

  console.log('')
  console.log('=== кошелёк', account.address, '===')
  console.log('BNB: ', formatEther(bnb))
  console.log('WBNB:', formatUnits(wbnbBal, 18), `($${(Number(formatUnits(wbnbBal, 18)) * usdPerWbnb).toFixed(2)})`)
  console.log('USDT:', formatUnits(usdtBal, 18))

  // ---------- проверка газа ----------
  const gasPrice = await read.getGasPrice()
  // approve ×2 + mint. Берём с запасом.
  const gasNeeded = 900_000n * gasPrice

  if (bnb < gasNeeded) {
    console.error('')
    console.error('ОСТАНОВКА: нет нативного BNB на газ.')
    console.error('  нужно:', formatEther(gasNeeded), 'BNB')
    console.error('  есть: ', formatEther(bnb), 'BNB')
    console.error('')
    console.error('WBNB для газа не подходит — это обычный токен ERC-20.')
    console.error('Отправьте на этот адрес 0.01 BNB в сети BSC.')
    process.exit(1)
  }

  // ---------- сколько вносим ----------
  // В диапазоне у текущей цены V3 требует ОБЕ монеты примерно поровну по
  // стоимости. Сколько именно — зависит от позиции цены внутри диапазона.
  const sqrtP = Number(sqrtPriceX96) / Number(Q96)
  const sqrtL = sqrtAtTick(tickLower)
  const sqrtU = sqrtAtTick(tickUpper)

  // Доли стоимости в token0 (USDT) и token1 (WBNB):
  // amount0 = L(sqrtU - sqrtP)/(sqrtP·sqrtU), amount1 = L(sqrtP - sqrtL).
  const a0PerL = (sqrtU - sqrtP) / (sqrtP * sqrtU)
  const a1PerL = sqrtP - sqrtL

  // Ограничение — что есть на кошельке. Ликвидность берём минимальную из
  // двух: иначе одна из монет кончится и транзакция упадёт.
  const LbyWbnb = a1PerL > 0 ? Number(wbnbBal) / 1e18 / a1PerL : 0
  const LbyUsdt = a0PerL > 0 ? Number(usdtBal) / 1e18 / a0PerL : 0

  let L = Math.min(LbyWbnb, LbyUsdt)

  // Если задана сумма USDT, считаем ликвидность от неё.
  if (usdtArg) {
    const want = Number(usdtArg)
    const Lwant = a0PerL > 0 ? want / a0PerL : 0
    L = Math.min(Lwant, LbyWbnb, LbyUsdt)
    if (L < Lwant) {
      console.log('')
      console.log(`(запрошено ${want} USDT, но баланса хватает только на ${(L * a0PerL).toFixed(2)} USDT)`)
    }
  }

  if (!(L > 0)) {
    console.error('')
    console.error('ОСТАНОВКА: не из чего собрать позицию.')
    if (LbyUsdt === 0) console.error('  нет USDT — в диапазоне у текущей цены нужны обе монеты')
    if (LbyWbnb === 0) console.error('  нет WBNB')
    console.error('')
    console.error('Сколько нужно при текущей цене:')
    const need0 = a0PerL * LbyWbnb
    console.error(`  USDT: ${need0.toFixed(2)} (к имеющемуся WBNB)`)
    process.exit(1)
  }

  // Переводим L в человеческие суммы.
  const amount0 = L * a0PerL
  const amount1 = L * a1PerL

  console.log('')
  console.log('=== план позиции ===')
  console.log(`  USDT: ${amount0.toFixed(6)}`)
  console.log(`  WBNB: ${amount1.toFixed(8)}`)
  console.log(`  стоимость: $${(amount0 + amount1 * usdPerWbnb).toFixed(2)}`)
  console.log(`  ликвидность L: ${Math.floor(L * 1e18)}`)

  // Округляем вниз: контракт спишет точные суммы по формуле, и если L
  // окажется чуть больше, чем покрывает баланс, mint упадёт.
  const Lfinal = BigInt(Math.floor(L * 1e18) - 1)
  if (Lfinal <= 0n) {
    console.error('\nслишком мала сумма позиции')
    process.exit(1)
  }

  if (dryRun) {
    console.log('\n--dry-run: транзакции не отправлены')
    return
  }

  // ---------- approve ----------
  const wallet = createWalletClient({ account, chain: bsc, transport: http(RPC_SEND) })

  for (const [sym, addr, need] of [
    ['USDT', USDT, BigInt(Math.ceil(amount0 * 1e18))],
    ['WBNB', WBNB, BigInt(Math.ceil(amount1 * 1e18))],
  ]) {
    const allowance = await read.readContract({
      address: addr,
      abi: erc20,
      functionName: 'allowance',
      args: [account.address, pool],
    })
    if (allowance >= need) {
      console.log(`\n${sym}: approve уже есть (${formatUnits(allowance, 18)})`)
      continue
    }
    console.log(`\n${sym}: approve...`)
    const hash = await wallet.writeContract({
      account,
      chain: bsc,
      address: addr,
      abi: erc20,
      functionName: 'approve',
      args: [pool, need],
      gas: 100_000n,
      gasPrice,
    })
    console.log('  транзакция:', hash)
    const rc = await read.waitForTransactionReceipt({ hash })
    console.log('  статус:', rc.status)
    if (rc.status !== 'success') {
      console.error(`  approve ${sym} не прошёл`)
      process.exit(1)
    }
  }

  // ---------- mint ----------
  console.log('\nдобавляем ликвидность...')
  const hashMint = await wallet.writeContract({
    account,
    chain: bsc,
    address: pool,
    abi: poolAbi,
    functionName: 'mint',
    args: [account.address, tickLower, tickUpper, Lfinal],
    gas: 1_000_000n,
    gasPrice,
  })
  console.log('  транзакция:', hashMint)

  const rcMint = await read.waitForTransactionReceipt({ hash: hashMint })
  console.log('  статус:', rcMint.status, '| газ:', rcMint.gasUsed)
  if (rcMint.status !== 'success') {
    console.error('\nmint не прошёл')
    process.exit(1)
  }

  // ---------- проверка ----------
  console.log('\n=== проверка на цепи ===')
  const [liq, slotAfter] = await Promise.all([
    read.readContract({ address: pool, abi: poolAbi, functionName: 'liquidity' }),
    read.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' }),
  ])

  // Позиция адресуется хешем (владелец, нижний тик, верхний тик) — NFT нет.
  const keyPos = await read.readContract({
    address: pool,
    abi: poolAbi,
    functionName: 'positions',
    args: [
      // keccak256(abi.encodePacked(owner, tickLower, tickUpper))
      (await import('viem')).keccak256(
        (await import('viem')).encodePacked(
          ['address', 'int24', 'int24'],
          [account.address, tickLower, tickUpper],
        ),
      ),
    ],
  })

  console.log('ликвидность пула:', liq.toString())
  console.log('позиция в диапазоне:', keyPos[0].toString())
  console.log('цена: 1 WBNB =', (1 / ((Number(slotAfter[0]) / Number(Q96)) ** 2)).toFixed(2), 'USDT')
  console.log('\nготово')
}

main().catch((e) => {
  console.error('ошибка:', e.cause?.shortMessage ?? e.shortMessage ?? e.message)
  process.exit(1)
})
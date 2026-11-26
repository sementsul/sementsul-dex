// Создание пула WBNB/USDT в нашей V3 и установка цены по рынку Pancake.
//
// Почему через bscrpc.pancakeswap.finance: это приватный RPC, транзакция идёт
// сразу валидаторам, минуя публичный мемпул. Обычный публичный RPC виден
// сэндвич-ботам, и они успевают встать перед нами и после. Здесь же подпись
// делается локально, а наружу уходит только готовый raw-транзакция.
//
// Две транзакции подряд:
//   1) createPool(tokenA, tokenB, fee) — фабрика деплоит контракт пула;
//   2) pool.initializePrice(sqrtPriceX96) — задаём цену.
//
// Цену задают ровно один раз и навсегда. Берём её из самого глубокого пула
// Pancake (0.01%), чтобы наш пул не отличался от рынка: иначе арбитраж
// вычерпает ликвидность в одну сторону в первой же сделке.
//
// Между (1) и (2) есть короткое окно, когда пул существует без цены и любой
// может задать её своей. Через приватный RPC окно — секунды, но не ноль.
// Уменьшить его нельзя без правки фабрики, поэтому делаем сразу и проверяем
// результат на цепи.
//
// Использование:
//   node scripts/create-pool-v3.mjs --dry-run
//   node scripts/create-pool-v3.mjs

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  http,
  formatEther,
  formatGwei,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')

// Приватный RPC Pancake: MEV-guard, транзакция не попадает в публичный мемпул.
const RPC_PRIVATE = 'https://bscrpc.pancakeswap.finance'
// Публичный — только для чтения. Отправлять через него нельзя: боты увидят.
const RPC_READ = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'

const FEE = Number(process.env.POOL_FEE ?? 500) // 0.05%, как у бота

function readEnv(name) {
  if (!existsSync(join(ROOT, '.env'))) return null
  const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'))
  return m ? m[1].trim() : null
}

const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))
const { default: d } = await import(new URL('../src/contracts/deployments.js', import.meta.url).href)

const WBNB = d.wbnb
const USDT = '0x55d398326f99059fF775485246999027B3197955'

const read = createPublicClient({ chain: bsc, transport: http(RPC_READ) })

const factoryAbi = artifacts.SementsulV3Factory.abi
const poolAbi = artifacts.SementsulV3Pool.abi

// ---------- цена с Pancake ----------
//
// Берём из пула 0.01%: он самый глубокий, цена в нём обновляется каждой
// сделкой, и именно по нему принимает решения бот.
const PANCAKE_REF = '0x172fcD41E0913e95784454622d1c3724f546f849'

async function main() {
  console.log('=== создание пула WBNB/USDT (V3, тир ' + FEE + ') ===\n')

  console.log('фабрика V3:', d.v3Factory)
  console.log('WBNB:      ', WBNB)
  console.log('USDT:      ', USDT)
  console.log('RPC отправки:', RPC_PRIVATE, '(MEV-guard, без публичного мемпула)')

  // Порядок важен: фабрика сортирует токены, и цена считается для token1/token0.
  const token0 = WBNB.toLowerCase() < USDT.toLowerCase() ? WBNB : USDT
  const token1 = token0 === WBNB ? USDT : WBNB
  console.log('')
  console.log('token0 (меньший адрес):', token0)
  console.log('token1:                 ', token1)

  // Цена из Pancake.
  const pSlot0 = await read.readContract({
    address: PANCAKE_REF,
    abi: poolAbi,
    functionName: 'slot0',
  })
  const pToken0 = await read.readContract({
    address: PANCAKE_REF,
    abi: poolAbi,
    functionName: 'token0',
  })
  const sqrtPriceX96 = pSlot0[0]

  console.log('')
  console.log('цена с Pancake (0.01%):')
  console.log('  sqrtPriceX96:', sqrtPriceX96)
  console.log('  tick:        ', Number(pSlot0[1]))
  console.log('  token0 у Pancake:', pToken0)

  // Если порядок токенов у Pancake совпадает с нашим, цена переносится как
  // есть. Если нет — её нужно обратить (1/p), иначе пул встанет «вверх
  // ногами» и первая же сделка вычерпает его.
  const sameOrder = pToken0.toLowerCase() === token0.toLowerCase()
  const finalSqrt = sameOrder ? sqrtPriceX96 : (2n ** 192n) / sqrtPriceX96

  console.log('')
  console.log('порядок токенов совпадает:', sameOrder ? 'да, цена переносится как есть' : 'НЕТ, цена обращена')
  console.log('sqrtPriceX96 для нашего пула:', finalSqrt)

  // Существующий пул?
  const existing = await read
    .readContract({
      address: d.v3Factory,
      abi: factoryAbi,
      functionName: 'getPool',
      args: [WBNB, USDT, FEE],
    })
    .catch(() => null)

  if (existing && existing !== '0x0000000000000000000000000000000000000000') {
    console.log('')
    console.log('ПУЛ УЖЕ СУЩЕСТВУЕТ:', existing)
    const slot0 = await read.readContract({ address: existing, abi: poolAbi, functionName: 'slot0' })
    console.log('  текущий sqrtPriceX96:', slot0[0])
    console.log('  цена уже задана:', slot0[0] === 0n ? 'НЕТ (можно задать)' : 'да')
    if (slot0[0] !== 0n) {
      console.log('\nцена задана, менять её нельзя — выходим')
      return
    }
  }

  // Предсказанный адрес — сверим с тем, что вернёт createPool.
  const predicted = await read.readContract({
    address: d.v3Factory,
    abi: factoryAbi,
    functionName: 'poolFor',
    args: [WBNB, USDT, FEE],
  })
  console.log('')
  console.log('адрес пула (предсказан):', predicted)

  const spacing = await read.readContract({
    address: d.v3Factory,
    abi: factoryAbi,
    functionName: 'tickSpacingFor',
    args: [FEE],
  })
  const delay = await read.readContract({
    address: d.v3Factory,
    abi: factoryAbi,
    functionName: 'jitDelayBlocks',
    args: [FEE],
  })
  console.log('шаг тика:', spacing, '| задержка JIT:', delay.toString(), 'блоков')

  if (dryRun) {
    console.log('\n--dry-run: транзакции не отправлены')
    return
  }

  // ---------- отправка ----------
  const privateKey = process.env.DEPLOYER_KEY ?? readEnv('DEPLOYER_KEY')
  if (!privateKey) {
    console.error('\nошибка: не задан DEPLOYER_KEY')
    process.exit(1)
  }

  const account = privateKeyToAccount(privateKey)
  // Клиент отправки — на приватный RPC. Подпись локальная, наружу уходит
  // только подписанная транзакция, поэтому ключ не покидает машину.
  const wallet = createWalletClient({ account, chain: bsc, transport: http(RPC_PRIVATE) })

  const bal = await read.getBalance({ address: account.address })
  const gasPrice = await read.getGasPrice()
  console.log('')
  console.log('отправитель:', account.address)
  console.log('  BNB:', formatEther(bal))
  console.log('  газ:', formatGwei(gasPrice), 'gwei')

  // 1) createPool. Газ фиксируем: оценка через приватный RPC может не пройти,
  // а деплой пула стабильно укладывается в 5 млн (замер — 4.3 млн).
  console.log('\n[1/2] createPool...')
  const h1 = await wallet.writeContract({
    account,
    chain: bsc,
    address: d.v3Factory,
    abi: factoryAbi,
    functionName: 'createPool',
    args: [WBNB, USDT, FEE],
    gas: 5_000_000n,
    gasPrice,
  })
  console.log('  транзакция:', h1)
  const r1 = await read.waitForTransactionReceipt({ hash: h1 })
  console.log('  статус:', r1.status, '| газ:', r1.gasUsed)
  if (r1.status !== 'success') {
    console.error('  createPool не прошёл')
    process.exit(1)
  }

  const poolAddress = await read.readContract({
    address: d.v3Factory,
    abi: factoryAbi,
    functionName: 'getPool',
    args: [WBNB, USDT, FEE],
  })
  console.log('  адрес пула:', poolAddress)
  if (poolAddress.toLowerCase() !== predicted.toLowerCase()) {
    console.log('  ВНИМАНИЕ: адрес отличается от предсказанного')
  }

  // 2) initializePrice. Сразу же, чтобы окно без цены было минимальным.
  console.log('\n[2/2] initializePrice...')
  const h2 = await wallet.writeContract({
    account,
    chain: bsc,
    address: poolAddress,
    abi: poolAbi,
    functionName: 'initializePrice',
    args: [finalSqrt],
    gas: 300_000n,
    gasPrice,
  })
  console.log('  транзакция:', h2)
  const r2 = await read.waitForTransactionReceipt({ hash: h2 })
  console.log('  статус:', r2.status, '| газ:', r2.gasUsed)
  if (r2.status !== 'success') {
    console.error('  initializePrice не прошёл')
    process.exit(1)
  }

  // ---------- проверка ----------
  console.log('\n=== проверка на цепи ===\n')
  const slot0 = await read.readContract({ address: poolAddress, abi: poolAbi, functionName: 'slot0' })
  const liq = await read.readContract({ address: poolAddress, abi: poolAbi, functionName: 'liquidity' })
  const t0 = await read.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token0' })
  const t1 = await read.readContract({ address: poolAddress, abi: poolAbi, functionName: 'token1' })
  const feeOnChain = await read.readContract({ address: poolAddress, abi: poolAbi, functionName: 'fee' })
  const spacingOnChain = await read.readContract({ address: poolAddress, abi: poolAbi, functionName: 'tickSpacing' })

  console.log('пул:          ', poolAddress)
  console.log('token0:       ', t0)
  console.log('token1:       ', t1)
  console.log('комиссия:     ', feeOnChain.toString(), '(1e-6)')
  console.log('шаг тика:     ', spacingOnChain.toString())
  console.log('sqrtPriceX96: ', slot0[0].toString())
  console.log('tick:         ', Number(slot0[1]))
  console.log('liquidity:    ', liq.toString(), liq === 0n ? '(пусто — нужна ликвидность)' : '')

  if (slot0[0] !== finalSqrt) {
    console.error('\nВНИМАНИЕ: цена на цепи не совпадает с заданной')
    process.exit(1)
  }
  console.log('\nцена установлена и совпадает с Pancake')
}

main().catch((e) => {
  console.error('ошибка:', e.cause?.shortMessage ?? e.shortMessage ?? e.message)
  process.exit(1)
})
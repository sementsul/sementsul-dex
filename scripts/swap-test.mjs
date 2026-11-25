// Тестовый своп SEM -> WBNB через наш роутер, чтобы в пуле появилась сделка.
//
// Зачем: BscScan и агрегаторы берут цену из последней СДЕЛКИ, а не из резервов
// пула. Пока в пуле ни одного свопа, показывать нечего.
//
// Безопасность:
//   - сначала approve ровно на сумму свопа, не на весь баланс (одобрение на
//     максимум — привычка, из-за которой потом можно потерять всё);
//   - amountOutMin считается из getAmountsOut с запасом на проскальзывание,
//     чтобы песочница не вывернула сделку в ноль;
//   - --dry-run показывает расчёт и ничего не отправляет.
//
// Использование:
//   node scripts/swap-test.mjs --amount 0.5 --dry-run
//   node scripts/swap-test.mjs --amount 0.5

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, http, formatUnits, formatEther, formatGwei, parseUnits } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const RPC = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'

function readEnv(name) {
  if (!existsSync(join(ROOT, '.env'))) return null
  const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'))
  return m ? m[1].trim() : null
}

function getArg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : fallback
}

const AMOUNT_IN = getArg('--amount', '0.5')
// Проскальзывание: 5%. Для тестового свопа на тонком пуле этого достаточно,
// чтобы транзакция прошла, но недостаточно, чтобы её можно было выпотрошить.
const SLIPPAGE_BPS = BigInt(getArg('--slippage-bps', '500'))

const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))
const { default: d } = await import(new URL('../src/contracts/deployments.js', import.meta.url).href)

const TOKEN = d.token
const WBNB = d.wbnb
const ROUTER = d.router
const PAIR = d.tradesPair ?? '0x64Dbdff7478fb32A61d8BbA84a29983412FFeb18'

const erc20 = artifacts.SementsulToken.abi
const routerAbi = artifacts.SementsulRouter.abi
const pairAbi = artifacts.SementsulPair.abi

const c = createPublicClient({ chain: bsc, transport: http(RPC) })

const amountIn = parseUnits(AMOUNT_IN, 18)
// Продаём SEM за WBNB: путь [SEM, WBNB].
const path = [TOKEN, WBNB]

async function main() {
  console.log('=== тестовый своп SEM -> WBNB ===\n')
  console.log('роутер:', ROUTER)
  console.log('пара:  ', PAIR)
  console.log('сумма: ', AMOUNT_IN, 'SEM')

  const res = await c.readContract({
    address: PAIR,
    abi: pairAbi,
    functionName: 'getReserves',
  })
  const [t0, t1] = await Promise.all([
    c.readContract({ address: PAIR, abi: pairAbi, functionName: 'token0' }),
    c.readContract({ address: PAIR, abi: pairAbi, functionName: 'token1' }),
  ])
  const isWbnbToken0 = t0.toLowerCase() === WBNB.toLowerCase()
  const reserveWbnb = isWbnbToken0 ? res[0] : res[1]
  const reserveSem = isWbnbToken0 ? res[1] : res[0]

  console.log('\nрезервы сейчас:')
  console.log(`  WBNB: ${formatUnits(reserveWbnb, 18)}`)
  console.log(`  SEM:  ${formatUnits(reserveSem, 18)}`)
  console.log(`  цена: 1 SEM = ${Number(formatUnits(reserveWbnb, 18)) / Number(formatUnits(reserveSem, 18))} WBNB`)

  const amounts = await c.readContract({
    address: ROUTER,
    abi: routerAbi,
    functionName: 'getAmountsOut',
    args: [amountIn, path],
  })
  const expected = amounts[amounts.length - 1]
  const minOut = (expected * (10_000n - SLIPPAGE_BPS)) / 10_000n

  console.log('\nрасчёт:')
  console.log(`  получим примерно: ${formatEther(expected)} WBNB`)
  console.log(`  минимум (проскальзывание ${Number(SLIPPAGE_BPS) / 100}%): ${formatEther(minOut)} WBNB`)

  const privateKey = process.env.DEPLOYER_KEY ?? readEnv('DEPLOYER_KEY')
  if (!privateKey && !dryRun) {
    console.error('\nошибка: не задан DEPLOYER_KEY')
    process.exit(1)
  }

  if (!privateKey) {
    console.log('\n--dry-run: транзакция не отправлена')
    return
  }

  const account = privateKeyToAccount(privateKey)
  const walletClient = createWalletClient({ account, chain: bsc, transport: http(RPC) })

  const [bal, bnb, allowance] = await Promise.all([
    c.readContract({ address: TOKEN, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
    c.getBalance({ address: account.address }),
    c.readContract({ address: TOKEN, abi: erc20, functionName: 'allowance', args: [account.address, ROUTER] }),
  ])

  console.log(`\nотправитель: ${account.address}`)
  console.log(`  SEM: ${formatUnits(bal, 18)}`)
  console.log(`  BNB: ${formatEther(bnb)}`)
  console.log(`  одобрено роутеру: ${formatUnits(allowance, 18)} SEM`)

  if (bal < amountIn) {
    console.error(`\nнедостаточно SEM: нужно ${AMOUNT_IN}`)
    process.exit(1)
  }

  if (dryRun) {
    console.log('\n--dry-run: транзакция не отправлена')
    return
  }

  const gasPrice = await c.getGasPrice()
  console.log(`\nгаз: ${formatGwei(gasPrice)} gwei`)

  // Approve ровно на сумму свопа, а не на максимум.
  if (allowance < amountIn) {
    console.log('одобряем SEM роутеру...')
    const h = await walletClient.writeContract({
      account,
      chain: bsc,
      address: TOKEN,
      abi: erc20,
      functionName: 'approve',
      args: [ROUTER, amountIn],
      gasPrice,
    })
    const r = await c.waitForTransactionReceipt({ hash: h })
    if (r.status !== 'success') {
      console.error('  approve не прошёл')
      process.exit(1)
    }
    console.log(`  ok: ${h}`)
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
  console.log('отправляем своп...')
  const hash = await walletClient.writeContract({
    account,
    chain: bsc,
    address: ROUTER,
    abi: routerAbi,
    functionName: 'swapExactTokensForTokens',
    args: [amountIn, minOut, path, account.address, deadline],
    gasPrice,
  })
  console.log(`  транзакция: ${hash}`)

  const receipt = await c.waitForTransactionReceipt({ hash })
  console.log(`  статус: ${receipt.status}, газ: ${receipt.gasUsed}, блок: ${receipt.blockNumber}`)

  if (receipt.status !== 'success') {
    console.error('  СВОП ОТМЕНЁН')
    process.exit(1)
  }

  const resAfter = await c.readContract({ address: PAIR, abi: pairAbi, functionName: 'getReserves' })
  const wbnbAfter = isWbnbToken0 ? resAfter[0] : resAfter[1]
  const semAfter = isWbnbToken0 ? resAfter[1] : resAfter[0]

  console.log('\nрезервы после:')
  console.log(`  WBNB: ${formatUnits(wbnbAfter, 18)}`)
  console.log(`  SEM:  ${formatUnits(semAfter, 18)}`)
  console.log(`  цена: 1 SEM = ${Number(formatUnits(wbnbAfter, 18)) / Number(formatUnits(semAfter, 18))} WBNB`)

  const swapLog = receipt.logs.find((l) => l.topics[0] === '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822')
  console.log('\nсобытие Swap в чеке:', swapLog ? 'ЕСТЬ' : 'НЕТ')
  console.log('\nсделка состоялась — теперь у пула есть история для графика')
}

main().catch((e) => {
  console.error('ошибка:', e.cause?.shortMessage ?? e.shortMessage ?? e.message)
  process.exit(1)
})
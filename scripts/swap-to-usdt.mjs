// Обмен WBNB на USDT через роутер Pancake V2.
//
// Нужен, чтобы собрать пропорцию для пула: в диапазоне вокруг текущей цены
// V3 требует обе монеты примерно поровну по стоимости. У нас на кошельке
// только WBNB, поэтому половину надо обменять.
//
// ПОЧЕМУ НЕ СВОЙ ПУЛ
// -----------------
// Наш пул WBNB/USDT пока пустой — обменивать в нём нечего. Поэтому идём
// через чужую ликвидность Pancake, у которой глубина достаточная, чтобы
// обмен на ~$100 не сдвинул цену.
//
// ЗАЩИТА ОТ ПРОСКАЛЬЗЫВАНИЯ
// -------------------------
// amountOutMin считается из котировки с запасом 1%. Ноль в этом поле
// означал бы «согласен на любой результат» — на тонком пуле это подарок
// арбитражу. Сделка идёт через приватный RPC, поэтому её не видно в
// публичном мемпуле.
//
// Использование:
//   node scripts/swap-to-usdt.mjs --dry-run
//   node scripts/swap-to-usdt.mjs                 (обменять половину)
//   node scripts/swap-to-usdt.mjs --amount 0.1    (конкретную сумму WBNB)

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
  parseEther,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const RPC_SEND = 'https://bscrpc.pancakeswap.finance'
const RPC_READ = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'

const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const USDT = '0x55d398326f99059fF775485246999027B3197955'

// Pancake V2 router: через него идёт обмен по существующей глубокой паре.
const ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E'

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

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

const routerAbi = parseAbi([
  'function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
])

const read = createPublicClient({ chain: bsc, transport: http(RPC_READ) })

async function main() {
  console.log('=== обмен WBNB -> USDT ===\n')

  const key = process.env.RECEIVER_KEY ?? readEnv('RECEIVER_KEY')
  if (!key) {
    console.error('нет RECEIVER_KEY в .env')
    process.exit(1)
  }
  const account = privateKeyToAccount(key.startsWith('0x') ? key : '0x' + key)
  console.log('кошелёк:', account.address)
  console.log('роутер: ', ROUTER, '(Pancake V2)')
  console.log('RPC отправки:', RPC_SEND, '(MEV-guard)')

  const [wbnbBal, usdtBal, bnbBal, gasPrice] = await Promise.all([
    read.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
    read.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
    read.getBalance({ address: account.address }),
    read.getGasPrice(),
  ])

  console.log('')
  console.log('WBNB:', formatUnits(wbnbBal, 18))
  console.log('USDT:', formatUnits(usdtBal, 18))
  console.log('BNB: ', formatEther(bnbBal))

  if (wbnbBal === 0n) {
    console.error('\nWBNB нет — обменивать нечего')
    process.exit(1)
  }

  // Сумма обмена: по умолчанию половина баланса, чтобы после обмена обеих
  // монет было поровну по стоимости — ровно то, что нужно пулу.
  const amountArg = arg('--amount')
  const amountIn = amountArg ? parseEther(amountArg) : wbnbBal / 2n

  if (amountIn > wbnbBal) {
    console.error('\nсумма больше баланса')
    process.exit(1)
  }

  // ---------- котировка ----------
  const amounts = await read.readContract({
    address: ROUTER,
    abi: routerAbi,
    functionName: 'getAmountsOut',
    args: [amountIn, [WBNB, USDT]],
  })
  const expected = amounts[1]

  // Запас 1%: цена за время между котировкой и исполнением может сдвинуться.
  // Меньше запас делать рискованно на волатильной паре, больше — сделка может
  // не пройти впустую.
  const minOut = (expected * 99n) / 100n

  const rate = Number(formatUnits(expected, 18)) / Number(formatUnits(amountIn, 18))

  console.log('')
  console.log('=== обмен ===')
  console.log('  отдаём:  ', formatUnits(amountIn, 18), 'WBNB')
  console.log('  получим: ', formatUnits(expected, 18), 'USDT (по котировке)')
  console.log('  минимум: ', formatUnits(minOut, 18), 'USDT (запас 1%)')
  console.log('  курс:    ', rate.toFixed(2), 'USDT за 1 WBNB')
  console.log('  останется WBNB:', formatUnits(wbnbBal - amountIn, 18))

  // Газ: approve + swap.
  const gasNeeded = 400_000n * gasPrice
  if (bnbBal < gasNeeded) {
    console.error('')
    console.error('ОСТАНОВКА: не хватает BNB на газ')
    console.error('  нужно:', formatEther(gasNeeded), 'есть:', formatEther(bnbBal))
    process.exit(1)
  }

  if (dryRun) {
    console.log('\n--dry-run: ничего не отправлено')
    return
  }

  const wallet = createWalletClient({ account, chain: bsc, transport: http(RPC_SEND) })

  // ---------- approve ----------
  const allowance = await read.readContract({
    address: WBNB,
    abi: erc20,
    functionName: 'allowance',
    args: [account.address, ROUTER],
  })

  if (allowance < amountIn) {
    console.log('\napprove WBNB роутеру...')
    const hashA = await wallet.writeContract({
      account,
      chain: bsc,
      address: WBNB,
      abi: erc20,
      functionName: 'approve',
      args: [ROUTER, amountIn],
      gas: 100_000n,
      gasPrice,
    })
    console.log('  транзакция:', hashA)
    const rcA = await read.waitForTransactionReceipt({ hash: hashA })
    console.log('  статус:', rcA.status)
    if (rcA.status !== 'success') {
      console.error('  approve не прошёл')
      process.exit(1)
    }
  } else {
    console.log('\napprove уже есть')
  }

  // ---------- swap ----------
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
  console.log('\nобмен...')
  const hash = await wallet.writeContract({
    account,
    chain: bsc,
    address: ROUTER,
    abi: routerAbi,
    functionName: 'swapExactTokensForTokens',
    args: [amountIn, minOut, [WBNB, USDT], account.address, deadline],
    gas: 400_000n,
    gasPrice,
  })
  console.log('  транзакция:', hash)

  const rc = await read.waitForTransactionReceipt({ hash })
  console.log('  статус:', rc.status, '| газ:', rc.gasUsed)
  if (rc.status !== 'success') {
    console.error('\nобмен не прошёл — WBNB остался на месте')
    process.exit(1)
  }

  // ---------- проверка ----------
  const [wbnbAfter, usdtAfter] = await Promise.all([
    read.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
    read.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [account.address] }),
  ])

  console.log('')
  console.log('=== после обмена ===')
  console.log('WBNB:', formatUnits(wbnbAfter, 18))
  console.log('USDT:', formatUnits(usdtAfter, 18))

  const gained = usdtAfter - usdtBal
  console.log('')
  console.log('получено USDT:', formatUnits(gained, 18))
  if (gained < minOut) {
    console.error('ВНИМАНИЕ: получено меньше минимума — проверьте сделку')
    process.exit(1)
  }
  console.log('готово')
}

main().catch((e) => {
  console.error('ошибка:', e.cause?.shortMessage ?? e.shortMessage ?? e.message)
  process.exit(1)
})
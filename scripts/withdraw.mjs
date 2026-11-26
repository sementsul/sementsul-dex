// Вывод средств с кошелька на адрес получателя.
//
// Отправляет BNB и токены (USDT, WBNB, SEM и любые другие) на заданный адрес
// через приватный RPC Pancake. Публичный мемпул не используется: иначе
// транзакцию видно сэндвич-ботам, и они могут попытаться встать перед ней.
//
// Важная деталь про BNB: газ платится в BNB, поэтому «вывести всё» надо так,
// чтобы на счету осталось на газ. Скрипт считает эту сумму сам: цена газа ×
// запас на одну транзакцию. Ключ --all-keep-gas выводит BNB за вычетом газа.
//
// Порядок для токенов: сначала transfer, потом ждём подтверждения, и только
// затем следующий токен. Так видно, что именно прошло, а что нет.
//
// Использование:
//   node scripts/withdraw.mjs --list
//   node scripts/withdraw.mjs --to 0x... --dry-run
//   node scripts/withdraw.mjs --to 0x... --token USDT
//   node scripts/withdraw.mjs --to 0x... --all
//   node scripts/withdraw.mjs --to 0x... --bnb 0.5

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  formatEther,
  parseEther,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// Приватный RPC: транзакция идёт сразу валидаторам, минуя публичный мемпул.
const RPC_SEND = 'https://bscrpc.pancakeswap.finance'
const RPC_READ = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'

// Известные токены BSC. Адреса в нижнем регистре для сравнения.
const TOKENS = {
  USDT: { address: '0x55d398326f99059fF775485246999027B3197955', decimals: 18 },
  WBNB: { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', decimals: 18 },
  SEM: { address: '0xc729a8fdf0591eaa897f786d4234989a2c39ad0a', decimals: 18 },
  BUSD: { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', decimals: 18 },
  CAKE: { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', decimals: 18 },
}

const dryRun = process.argv.includes('--dry-run')
const listOnly = process.argv.includes('--list')
const allTokens = process.argv.includes('--all')
const keepGas = process.argv.includes('--all-keep-gas')

const erc20 = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
])

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

const read = createPublicClient({ chain: bsc, transport: http(RPC_READ) })

async function balanceOf(token, owner) {
  try {
    return await read.readContract({
      address: token.address,
      abi: erc20,
      functionName: 'balanceOf',
      args: [owner],
    })
  } catch {
    return 0n
  }
}

async function main() {
  const key = process.env.RECEIVER_KEY ?? readEnv('RECEIVER_KEY')
  if (!key) {
    console.error('ошибка: нет RECEIVER_KEY в .env')
    console.error('создайте кошелёк: node scripts/create-receiver.mjs')
    process.exit(1)
  }

  const account = privateKeyToAccount(key.startsWith('0x') ? key : '0x' + key)

  // --from позволяет вывести с другого кошелька, если его ключ задан
  // в переменной окружения WITHDRAW_KEY.
  const fromKey = process.env.WITHDRAW_KEY ?? key
  const from = privateKeyToAccount(fromKey.startsWith('0x') ? fromKey : '0x' + fromKey)

  const to = arg('--to')

  console.log('=== вывод средств ===\n')
  console.log('с кошелька:', from.address)
  console.log('ключ получателя:', account.address)
  console.log('RPC отправки:', RPC_SEND, '(MEV-guard)')

  const bnb = await read.getBalance({ address: from.address })
  console.log('\nBNB:', formatEther(bnb))

  const found = []
  for (const [sym, t] of Object.entries(TOKENS)) {
    const b = await balanceOf(t.address, from.address)
    if (b > 0n) {
      found.push({ sym, ...t, balance: b })
      console.log(`${sym}: ${formatUnits(b, t.decimals)}`)
    }
  }

  if (!found.length && bnb === 0n) {
    console.log('\nбалансов нет — выводить нечего')
    return
  }

  if (listOnly) {
    console.log('\n--list: только показали, ничего не отправлено')
    return
  }

  if (!to) {
    console.error('\nошибка: укажите --to 0x... (куда выводить)')
    process.exit(1)
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    console.error('\nошибка: адрес получателя выглядит неверно:', to)
    process.exit(1)
  }

  const wallet = createWalletClient({ account: from, chain: bsc, transport: http(RPC_SEND) })
  const gasPrice = await read.getGasPrice()

  // Сколько оставить на газ: одна транзакция ERC-20 ≈ 60k газа, плюс запас.
  const gasReserve = 150_000n * gasPrice
  console.log('\nрезерв на газ:', formatEther(gasReserve), 'BNB')

  // ---------- токены ----------
  const only = arg('--token')
  const targets = only
    ? found.filter((t) => t.sym.toLowerCase() === only.toLowerCase())
    : allTokens
      ? found
      : found

  if (only && !targets.length) {
    console.error(`\nошибка: на кошельке нет ${only}`)
    process.exit(1)
  }

  for (const t of targets) {
    const amount = t.balance
    console.log(`\n${t.sym}: отправляем ${formatUnits(amount, t.decimals)} на ${to}`)

    if (dryRun) {
      console.log('  [dry-run] не отправлено')
      continue
    }

    try {
      const hash = await wallet.writeContract({
        account: from,
        chain: bsc,
        address: t.address,
        abi: erc20,
        functionName: 'transfer',
        args: [to, amount],
        gas: 100_000n,
        gasPrice,
      })
      console.log('  транзакция:', hash)
      const receipt = await read.waitForTransactionReceipt({ hash })
      console.log('  статус:', receipt.status, '| газ:', receipt.gasUsed)
      if (receipt.status !== 'success') console.error(`  ${t.sym} НЕ ОТПРАВЛЕН`)
    } catch (e) {
      console.error('  ошибка:', e.cause?.shortMessage ?? e.shortMessage ?? e.message)
    }
  }

  // ---------- BNB ----------
  const bnbArg = arg('--bnb')
  const wantBnb = bnbArg ? parseEther(bnbArg) : keepGas ? bnb - gasReserve : 0n

  if (wantBnb > 0n) {
    if (wantBnb > bnb - gasReserve) {
      console.error(`\nошибка: на газ останется слишком мало (нужно ${formatEther(gasReserve)} BNB)`)
    } else {
      console.log(`\nBNB: отправляем ${formatEther(wantBnb)} на ${to}`)
      if (dryRun) {
        console.log('  [dry-run] не отправлено')
      } else {
        try {
          const hash = await wallet.sendTransaction({
            account: from,
            chain: bsc,
            to,
            value: wantBnb,
            gas: 21_000n,
            gasPrice,
          })
          console.log('  транзакция:', hash)
          const receipt = await read.waitForTransactionReceipt({ hash })
          console.log('  статус:', receipt.status, '| газ:', receipt.gasUsed)
        } catch (e) {
          console.error('  ошибка:', e.cause?.shortMessage ?? e.shortMessage ?? e.message)
        }
      }
    }
  }

  if (dryRun) {
    console.log('\n--dry-run: транзакции не отправлены')
    return
  }

  // ---------- проверка ----------
  console.log('\n=== после вывода ===')
  console.log('BNB на отправителе:', formatEther(await read.getBalance({ address: from.address })))
  for (const [sym, t] of Object.entries(TOKENS)) {
    const b = await balanceOf(t.address, from.address)
    if (b === 0n && !found.some((f) => f.sym === sym)) continue
    console.log(`${sym}: ${formatUnits(b, t.decimals)}`)
  }
}

main().catch((e) => {
  console.error('ошибка:', e.cause?.shortMessage ?? e.shortMessage ?? e.message)
  process.exit(1)
})
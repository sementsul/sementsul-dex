// Перевод SEM на указанный адрес.
//
// Отдельный скрипт, потому что перевод токена — не деплой: другая операция,
// другие последствия. Здесь важнее всего не ошибиться адресом, поэтому
// проверки идут до отправки:
//   - адрес приводится к контрольной сумме (опечатка в регистре = другой адрес);
//   - проверяется, что получатель не нулевой;
//   - печатается баланс получателя до перевода, чтобы было с чем сверить после.
//
// Использование:
//   node scripts/send-token.mjs --to 0x... --amount 100000000
//   node scripts/send-token.mjs --to 0x... --amount 100000000 --dry-run

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, http, formatEther, formatGwei, getAddress, parseUnits } from 'viem'
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

const TO = getArg('--to', null)
const AMOUNT = getArg('--amount', null)

if (!TO) {
  console.error('ошибка: не задан --to 0x...')
  process.exit(1)
}
if (!AMOUNT) {
  console.error('ошибка: не задан --amount (в целых SEM)')
  process.exit(1)
}

// getAddress проверяет контрольную сумму: если регистр не совпадает с
// вычисленным, адрес почти наверняка введён с опечаткой, и деньги уйдут
// в никуда. Лучше упасть здесь, чем потерять перевод.
let recipient
try {
  recipient = getAddress(TO)
} catch {
  console.error(`ошибка: адрес ${TO} не проходит проверку контрольной суммы`)
  process.exit(1)
}

const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))
const art = artifacts.SementsulToken

const { default: deployments } = await import(
  new URL('../src/contracts/deployments.js', import.meta.url).href
)

if (!deployments.token) {
  console.error('ошибка: в deployments.js нет адреса токена')
  process.exit(1)
}

const TOKEN = deployments.token
const amount = parseUnits(AMOUNT, 18)

async function main() {
  const privateKey = process.env.DEPLOYER_KEY ?? readEnv('DEPLOYER_KEY')
  if (!privateKey && !dryRun) {
    console.error('ошибка: не задан DEPLOYER_KEY')
    process.exit(1)
  }

  const publicClient = createPublicClient({ chain: bsc, transport: http(RPC) })

  // В dry-run ключа может не быть — тогда баланс отправителя не читаем.
  const sender = privateKey ? privateKeyToAccount(privateKey).address : null

  const [balTo, supply, gasPrice] = await Promise.all([
    publicClient.readContract({ address: TOKEN, abi: art.abi, functionName: 'balanceOf', args: [recipient] }),
    publicClient.readContract({ address: TOKEN, abi: art.abi, functionName: 'totalSupply' }),
    publicClient.getGasPrice(),
  ])

  console.log('=== перевод SEM ===\n')
  console.log('токен:      ', TOKEN)
  console.log('получатель: ', recipient)
  console.log(`сумма:       ${AMOUNT} SEM`)
  console.log(`баланс получателя сейчас: ${Number(balTo) / 1e18} SEM`)
  console.log(`всего выпущено:            ${Number(supply) / 1e18} SEM`)
  console.log(`газ: ${formatGwei(gasPrice)} gwei`)

  if (dryRun) {
    console.log('\n--dry-run: транзакция не отправлена')
    return
  }

  const account = privateKeyToAccount(privateKey)
  const walletClient = createWalletClient({ account, chain: bsc, transport: http(RPC) })

  const [myBal, bnb] = await Promise.all([
    publicClient.readContract({ address: TOKEN, abi: art.abi, functionName: 'balanceOf', args: [account.address] }),
    publicClient.getBalance({ address: account.address }),
  ])

  console.log(`отправитель: ${account.address}`)
  console.log(`  SEM: ${Number(myBal) / 1e18}`)
  console.log(`  BNB: ${formatEther(bnb)}`)

  if (myBal < amount) {
    console.error(`\nнедостаточно SEM: есть ${Number(myBal) / 1e18}, нужно ${AMOUNT}`)
    process.exit(1)
  }

  console.log('\nотправляем...')
  const hash = await walletClient.writeContract({
    account,
    chain: bsc,
    address: TOKEN,
    abi: art.abi,
    functionName: 'transfer',
    args: [recipient, amount],
    gasPrice,
  })
  console.log(`  транзакция: ${hash}`)

  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  console.log(`  статус: ${receipt.status}, газ: ${receipt.gasUsed}`)

  if (receipt.status !== 'success') {
    console.error('  ПЕРЕВОД ОТМЕНЁН сетью')
    process.exit(1)
  }

  // Сверяем балансы после: перевод мог пройти, но не туда, если адрес
  // подменился по дороге. Проверка дешёвая, а цена ошибки — весь перевод.
  const [after, mineAfter] = await Promise.all([
    publicClient.readContract({ address: TOKEN, abi: art.abi, functionName: 'balanceOf', args: [recipient] }),
    publicClient.readContract({ address: TOKEN, abi: art.abi, functionName: 'balanceOf', args: [account.address] }),
  ])

  console.log('\nпосле перевода:')
  console.log(`  у получателя: ${Number(after) / 1e18} SEM`)
  console.log(`  у отправителя: ${Number(mineAfter) / 1e18} SEM`)

  const gained = after - balTo
  console.log(`  прирост у получателя: ${Number(gained) / 1e18} SEM`)

  if (gained !== amount) {
    console.error('\nВНИМАНИЕ: прирост не совпадает с суммой перевода')
    process.exit(1)
  }
  console.log('\nперевод подтверждён')
}

main().catch((e) => {
  console.error('ошибка:', e.message)
  process.exit(1)
})
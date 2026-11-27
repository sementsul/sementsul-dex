// Перевод газа с кошелька зеркала на кошелёк владельца позиции.
//
// Зачем: чтобы снять ликвидность, нужна подпись владельца позиции (0x22eA…),
// а у него нет нативного BNB. Ключ зеркала есть, и это тот же владелец по
// смыслу — перевод между своими кошельками.
//
// Сколько: ровно столько, чтобы хватило на burn + два transfer, с запасом.
// Больше не отправляем: на зеркале осталось ~0.0027 BNB, и они нужны на
// публикации интерфейса в цепь (~0.00023 BNB за штуку).
//
// Использование:
//   node scripts/fund-gas.mjs            # только показать
//   node scripts/fund-gas.mjs --send     # отправить
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
// Получатель по умолчанию — владелец позиции. Для операций от админа
// фабрики адрес задаётся через --to.
const TO = (() => {
  const i = process.argv.indexOf('--to')
  const v = i === -1 ? null : process.argv[i + 1]
  return v && !v.startsWith('--') ? v : '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
})()
// Сумма по умолчанию — на одну-две транзакции. Для деплоя контрактов нужно
// больше, поэтому её можно задать: --amount 0.0003
const ai = process.argv.indexOf('--amount')
const AMOUNT = parseEther(ai === -1 ? '0.00003' : process.argv[ai + 1])
const SEND = process.argv.includes('--send')

const RPC_SEND = 'https://bscrpc.pancakeswap.finance'
const RPC_READ = 'https://bsc-rpc.publicnode.com'

function env(name) {
  const raw = readFileSync(join(ROOT, '.env'), 'utf8')
  const m = raw.match(new RegExp('^' + name + '\\s*=\\s*(.*)$', 'm'))
  if (!m) throw new Error(`в .env нет ${name}`)
  const v = m[1].trim().replace(/^["']|["']$/g, '')
  return v.startsWith('0x') ? v : '0x' + v
}

const account = privateKeyToAccount(env('MIRROR_KEY'))
const pub = createPublicClient({ chain: bsc, transport: http(RPC_READ, { timeout: 30_000 }) })
const wallet = createWalletClient({ account, chain: bsc, transport: http(RPC_SEND, { timeout: 60_000 }) })

const from = await pub.getBalance({ address: account.address })
const to = await pub.getBalance({ address: TO })

console.log('  отправитель:', account.address, '(ключ MIRROR_KEY)')
console.log('  получатель :', TO)
console.log('  баланс отправителя:', formatEther(from), 'BNB')
console.log('  баланс получателя :', formatEther(to), 'BNB')
console.log('  перевести         :', formatEther(AMOUNT), 'BNB')

if (!SEND) {
  console.log('\n  Это только план. Для выполнения: --send')
  process.exit(0)
}

if (from < AMOUNT + parseEther('0.00005')) {
  console.log('\n  ОСТАНОВ: на зеркале не хватит BNB на перевод + газ.')
  process.exit(1)
}

const hash = await wallet.sendTransaction({ to: TO, value: AMOUNT })
console.log('\n  отправлено:', hash)
const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
console.log('  статус:', r.status, ' блок:', r.blockNumber.toString())

const after = await pub.getBalance({ address: TO })
console.log('  баланс получателя теперь:', formatEther(after), 'BNB')
const left = await pub.getBalance({ address: account.address })
console.log('  остаток на зеркале      :', formatEther(left), 'BNB')
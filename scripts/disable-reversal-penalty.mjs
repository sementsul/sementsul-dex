// Выключение штрафа за разворот на тире 500.
//
// setReversalPenaltyK(500, 0) — единственная транзакция, k становится нулём,
// и в swap ветка начисления штрафа не срабатывает вовсе.
//
// ЧТО ЭТО МЕНЯЕТ ПО СУТИ
// ----------------------
// Штраф за разворот был защитой от сэндвича: тот, кто в одном блоке двигает
// цену в одну сторону, а потом обратно, платил соразмерно сдвигу. При k = 0
// этой платы нет.
//
// Становится выгоднее арбитраж — и одновременно возвращается возможность
// сэндвича. Обе стороны одной монеты, выбора «только арбитраж» не бывает.
//
// Ключ — DEPLOYER_KEY, он же админ фабрики. Других прав у админа нет:
// ни забрать ликвидность, ни изменить комиссию он не может.
//
// Использование:
//   node scripts/disable-reversal-penalty.mjs           # только показать
//   node scripts/disable-reversal-penalty.mjs --send    # выполнить
//   node scripts/disable-reversal-penalty.mjs --k 200000 --send   # ослабить, не выключать
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, http, parseAbi, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FACTORY = '0xc0b597bee57bba0aae2ce9e73e83217331a24dd9'
const SEND = process.argv.includes('--send')

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : fallback
}
const FEE = Number(arg('--fee', 500))
const K = Number(arg('--k', 0))

const RPC_SEND = 'https://bscrpc.pancakeswap.finance'
const RPC_READ = 'https://bsc-rpc.publicnode.com'

function env(name) {
  const raw = readFileSync(join(ROOT, '.env'), 'utf8')
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(new RegExp('^\\s*' + name + '\\s*=\\s*(.*)$'))
    if (m) {
      const v = m[1].trim().replace(/^["']|["']$/g, '')
      return v.startsWith('0x') ? v : '0x' + v
    }
  }
  throw new Error(`в .env нет ${name}`)
}

const abi = parseAbi([
  'function admin() view returns (address)',
  'function reversalPenaltyK(uint24) view returns (uint24)',
  'function maxReversalPenalty() view returns (uint24)',
  'function tickSpacingFor(uint24) view returns (int24)',
  'function setReversalPenaltyK(uint24 _fee, uint24 _k)',
])

const account = privateKeyToAccount(env('DEPLOYER_KEY'))
const pub = createPublicClient({ chain: bsc, transport: http(RPC_READ, { timeout: 30_000 }) })
const wallet = createWalletClient({ account, chain: bsc, transport: http(RPC_SEND, { timeout: 60_000 }) })

const [admin, kNow, cap, spacing] = await Promise.all([
  pub.readContract({ address: FACTORY, abi, functionName: 'admin' }),
  pub.readContract({ address: FACTORY, abi, functionName: 'reversalPenaltyK', args: [FEE] }),
  pub.readContract({ address: FACTORY, abi, functionName: 'maxReversalPenalty' }),
  pub.readContract({ address: FACTORY, abi, functionName: 'tickSpacingFor', args: [FEE] }),
])

console.log('=== СОСТОЯНИЕ ===')
console.log('  фабрика       :', FACTORY)
console.log('  админ         :', admin)
console.log('  наш ключ      :', account.address)
console.log('  тир           :', FEE, ' spacing:', Number(spacing))
console.log('  k сейчас      :', kNow.toString())
console.log('  потолок штрафа:', cap.toString(), `(${Number(cap) / 1e4}%)`)
console.log('  k станет      :', K)

if (admin.toLowerCase() !== account.address.toLowerCase()) {
  console.log('\n  ОСТАНОВ: ключ не от админа. Транзакция откатится.')
  process.exit(1)
}
if (Number(spacing) === 0) {
  console.log('\n  ОСТАНОВ: тир не включён в фабрике.')
  process.exit(1)
}
if (kNow === BigInt(K)) {
  console.log('\n  Уже установлено — менять нечего.')
  process.exit(0)
}

console.log('\n=== ЧТО ИЗМЕНИТСЯ ===')
if (K === 0) {
  console.log('  штраф выключается полностью.')
  console.log('  • арбитраж перестаёт платить сверху комиссии — расхождение цены')
  console.log('    с рынком становится доходом целиком;')
  console.log('  • сэндвич в одном блоке снова возможен: тот, кто двигает цену')
  console.log('    туда-обратно, больше не платит за разворот.')
} else {
  console.log(`  штраф ослабнет: при сдвиге цены платится ${(K / 1e6 * 100).toFixed(1)}% от сдвига вместо ${(Number(kNow) / 1e6 * 100).toFixed(0)}%.`)
}

const bnb = await pub.getBalance({ address: account.address })
const gasPrice = await pub.getGasPrice()
console.log('\n  BNB на газ:', formatEther(bnb))
console.log('  оценка газа: ~', formatEther(60_000n * gasPrice), 'BNB')
if (bnb < 60_000n * gasPrice) {
  console.log('\n  ОСТАНОВ: не хватает BNB на газ.')
  process.exit(1)
}

if (!SEND) {
  console.log('\n  Это только план. Для выполнения: --send')
  process.exit(0)
}

console.log('\n=== ВЫПОЛНЕНИЕ ===')
const hash = await wallet.writeContract({
  address: FACTORY, abi, functionName: 'setReversalPenaltyK', args: [FEE, K],
})
console.log('  отправлено:', hash)
const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
console.log('  статус:', r.status, ' блок:', r.blockNumber.toString(), ' газ:', r.gasUsed.toString())
if (r.status !== 'success') {
  console.log('\n  Транзакция откатилась. Значение не изменено.')
  process.exit(1)
}

const kAfter = await pub.readContract({ address: FACTORY, abi, functionName: 'reversalPenaltyK', args: [FEE] })
console.log('\n=== ПРОВЕРКА ===')
console.log('  k после транзакции:', kAfter.toString())
console.log('  ожидалось         :', K)
// viem отдаёт uint24 как number, а не BigInt: небольшие целые он приводит к
// Number. Сравнение `kAfter === BigInt(K)` всегда ложно и даёт пугающее
// «НЕ СОВПАЛО» при верном результате. Приводим обе стороны к Number.
console.log('  ' + (Number(kAfter) === K ? 'СОВПАДАЕТ — штраф изменён' : 'НЕ СОВПАЛО — проверить заново'))
if (Number(kAfter) !== K) process.exit(1)
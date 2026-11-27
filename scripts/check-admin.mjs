// Кто админ фабрики и можем ли мы вообще менять штраф.
//
// setReversalPenaltyK объявлен как onlyAdmin. Если админ — не наш адрес, то
// ни одна транзакция не пройдёт, сколько бы ключей у нас ни было. Поэтому
// сначала сверяем admin() с адресами, которые выводимы из .env.
import { createPublicClient, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'
import { readFileSync } from 'node:fs'

const FACTORY = '0xc0b597bee57bba0aae2ce9e73e83217331a24dd9'
const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const abi = parseAbi([
  'function admin() view returns (address)',
  'function reversalPenaltyK(uint24) view returns (uint24)',
  'function maxReversalPenalty() view returns (uint24)',
])

const admin = await client.readContract({ address: FACTORY, abi, functionName: 'admin' })
const k = await client.readContract({ address: FACTORY, abi, functionName: 'reversalPenaltyK', args: [500] })
const cap = await client.readContract({ address: FACTORY, abi, functionName: 'maxReversalPenalty' })

console.log('  админ фабрики      :', admin)
console.log('  reversalPenaltyK(500):', k.toString())
console.log('  maxReversalPenalty :', cap.toString(), `(${Number(cap) / 1e4}%)`)

// Какие ключи есть и совпадает ли хоть один с админом.
//
// Файл .env на Windows имеет переводы строк CRLF. Регулярка `.*` в JS не
// захватывает \r, поэтому значение приходило с хвостовым \r и ключ не
// распознавался — DEPLOYER_KEY молча считался отсутствующим. Делим по
// /\r?\n/, а хвостовой \r срезаем отдельно.
const env = {}
try {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/)
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
} catch {}

console.log('')
console.log('  ключи в .env:')
let match = null
for (const name of ['DEPLOYER_KEY', 'RECEIVER_KEY', 'MIRROR_KEY', 'BOT_PRIVATE_KEY']) {
  const raw = env[name]
  if (!raw) {
    console.log(`    ${name.padEnd(16)}: пусто или нет`)
    continue
  }
  try {
    const hex = raw.startsWith('0x') ? raw : '0x' + raw
    const acc = privateKeyToAccount(hex)
    const isAdmin = acc.address.toLowerCase() === admin.toLowerCase()
    console.log(`    ${name.padEnd(16)}: ${acc.address}${isAdmin ? '  <-- ЭТО АДМИН' : ''}`)
    if (isAdmin) match = name
  } catch (e) {
    console.log(`    ${name.padEnd(16)}: не читается (${String(e.message).slice(0, 40)})`)
  }
}

console.log('')
if (match) {
  console.log('  МОЖНО менять штраф ключом:', match)
} else {
  console.log('  НЕЛЬЗЯ: ни один ключ не соответствует админу фабрики.')
  console.log('  Транзакция откатится с Sementsul: FORBIDDEN.')
}
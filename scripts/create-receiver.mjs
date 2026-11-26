// Создание отдельного кошелька-получателя.
//
// Зачем отдельный: ключ деплоера лежит в .env и уже используется для
// контрактов. Смешивать его с деньгами биржи нельзя — при утечке одного
// потеряется всё сразу. Поэтому у получателя свой ключ (RECEIVER_KEY), а
// DEPLOYER_KEY остаётся только для деплоя.
//
// Ключ пишется в .env (файл в .gitignore). В консоль выводится ТОЛЬКО адрес:
// приватный ключ в логах терминала — это утечка, он остаётся в истории.
//
// Повторный запуск ничего не перезаписывает. Если ключ уже есть, скрипт
// покажет адрес и выйдет: перезапись потеряла бы деньги, отправленные на
// предыдущий адрес.
//
// Использование: node scripts/create-receiver.mjs

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, formatEther } from 'viem'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_PATH = join(ROOT, '.env')
const VAR = 'RECEIVER_KEY'

function readEnv() {
  if (!existsSync(ENV_PATH)) return {}
  const out = {}
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

const env = readEnv()
let privateKey = env[VAR]
let created = false

if (privateKey) {
  console.log('ключ получателя уже есть в .env — новый не создаю')
  console.log('(перезапись потеряла бы деньги, отправленные на текущий адрес)')
} else {
  privateKey = generatePrivateKey()
  if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey

  const block =
    '\n# Ключ кошелька-получателя: сюда выводятся средства с биржи.\n' +
    '# Отдельный от DEPLOYER_KEY, чтобы утечка одного не открывала второй.\n' +
    `${VAR}=${privateKey}\n`

  const prev = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  writeFileSync(ENV_PATH, prev + block, 'utf8')
  created = true
  console.log('ключ записан в .env как ' + VAR)
}

const account = privateKeyToAccount(privateKey)
const client = createPublicClient({
  chain: bsc,
  transport: http(process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'),
})
const bal = await client.getBalance({ address: account.address })

console.log('')
console.log(created ? 'АДРЕС НОВОГО КОШЕЛЬКА:' : 'АДРЕС КОШЕЛЬКА:')
console.log('')
console.log('    ' + account.address)
console.log('')
console.log('Сеть: BNB Smart Chain (BSC), chainId 56.')
console.log('Только BSC — в другой сети деньги потеряются.')
console.log('Баланс сейчас:', formatEther(bal), 'BNB')
console.log('')
console.log('Этот адрес указывайте как получателя в scripts/withdraw.mjs --to')
console.log('и в переменной WITHDRAW_TO бота, чтобы он выводил средства сюда.')
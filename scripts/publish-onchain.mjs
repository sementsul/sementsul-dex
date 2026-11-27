// Публикация зеркала в calldata BSC.
//
// Идея: данные транзакции (input) хранятся в блокчейне навсегда и стоят
// 16 газа за ненулевой байт. Кладём туда HTML и читаем обратно через
// eth_getTransactionByHash — это работает на любом публичном RPC, без
// индексатора, без IPFS, без нашего домена.
import { readFileSync, existsSync } from 'node:fs'
import {
  createWalletClient,
  createPublicClient,
  http,
  defineChain,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const FILE = args[0] ?? 'dist-onchain/index.html'
const DRY = process.argv.includes('--dry')

const env = {}
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

if (!env.MIRROR_KEY) {
  console.error('нет MIRROR_KEY в .env — сначала: node scripts/mirror-wallet.mjs')
  process.exit(1)
}

const bsc = defineChain({
  id: 56,
  name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: ['https://bsc-rpc.publicnode.com'] } },
})

const key = env.MIRROR_KEY.startsWith('0x') ? env.MIRROR_KEY : '0x' + env.MIRROR_KEY
const account = privateKeyToAccount(key)
const pub = createPublicClient({ chain: bsc, transport: http() })
const wallet = createWalletClient({ chain: bsc, transport: http(), account })

;(async () => {
  const html = readFileSync(FILE)
  const bytes = html.length

  console.log('=== подготовка ===')
  console.log('  файл:', FILE)
  console.log('  размер:', bytes, 'байт =', (bytes / 1024).toFixed(1), 'KB')
  console.log('  кошелёк:', account.address)

  const bal = await pub.getBalance({ address: account.address })
  const gasPrice = await pub.getGasPrice()
  const bnbUsd = 563.5

  // Оценка газа. Важная деталь: BSC применяет floor-правило из EIP-7623 —
  // минимум 40 газа за НЕНУЛЕВОЙ байт calldata, а не 16. Я сначала считал
  // по 16 и получил 1.33M при реальном требовании 3.3M; узел отказал с
  // «insufficient gas for floor data gas cost». Поэтому берём 40 и сверху
  // добавляем запас: цена газа тут мизерная, а повтор деплоя дороже.
  const zeroBytes = [...html].filter((b) => b === 0).length
  const nonZero = bytes - zeroBytes
  const FLOOR_PER_BYTE = 40n
  const dataGas = BigInt(nonZero) * FLOOR_PER_BYTE + BigInt(zeroBytes) * 4n
  const est = 21000n + dataGas

  const cost = est * gasPrice
  console.log('\n=== газ ===')
  console.log('  оценка:', est.toString())
  console.log('  gasPrice:', gasPrice.toString(), 'wei')
  console.log('  стоимость:', (Number(cost) / 1e18).toFixed(8), 'BNB = $' + ((Number(cost) / 1e18) * bnbUsd).toFixed(4))
  console.log('  баланс:', (Number(bal) / 1e18).toFixed(8), 'BNB = $' + ((Number(bal) / 1e18) * bnbUsd).toFixed(4))

  if (bal < cost) {
    console.log('\n=== НЕ ХВАТАЕТ СРЕДСТВ ===')
    const need = Number(cost) / 1e18
    const have = Number(bal) / 1e18
    console.log('  нужно:', need.toFixed(8), 'BNB')
    console.log('  есть: ', have.toFixed(8), 'BNB')
    console.log('  не хватает:', (need - have).toFixed(8), 'BNB = $' + ((need - have) * bnbUsd).toFixed(2))
    console.log('\n  пополните', account.address)
    process.exit(1)
  }

  if (DRY) {
    console.log('\n--dry: транзакция не отправлена')
    return
  }

  // Отправляем СЕБЕ: адрес тот же, data = HTML.
  // Так input транзакции равен файлу, и его можно прочитать обратно.
  console.log('\n=== отправляю ===')
  const hash = await wallet.sendTransaction({
    to: account.address,
    data: '0x' + html.toString('hex'),
    gas: est + est / 10n, // +10% запас
    gasPrice,
  })
  console.log('  tx:', hash)

  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120000 })
  console.log('  статус:', receipt.status)
  console.log('  блок:', receipt.blockNumber.toString())
  console.log('  газ использован:', receipt.gasUsed.toString())

  // Проверяем чтение обратно
  console.log('\n=== проверка чтения ===')
  const tx = await pub.getTransaction({ hash })
  const got = (tx.input.length - 2) / 2
  console.log('  input прочитан:', got, 'байт')
  console.log('  совпадает с файлом?', got === bytes)

  console.log('\n=== ГОТОВО ===')
  console.log('  tx:', hash)
  console.log('  читать: eth_getTransactionByHash("' + hash + '")')
  const need = Number(cost) / 1e18
  console.log('  потрачено: ~' + (Number(receipt.gasUsed) * Number(gasPrice) / 1e18).toFixed(8), 'BNB')
})().catch((e) => {
  console.error('ОШИБКА:', e.shortMessage ?? e.message)
  if (e.details) console.error('  ', e.details)
})
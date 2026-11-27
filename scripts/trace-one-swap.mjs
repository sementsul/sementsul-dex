// Разбор одной транзакции целиком: какие контракты она трогает на самом деле.
//
// Предыдущая проверка искала в логах событие Swap от Pancake 0.01% — и не
// нашла. Но `who-are-they` показал «пулы в транзакции: Pancake 0.01%, наш
// пул». Значит расхождение в том, КАК я ищу: скорее всего Swap у Pancake
// имеет другую сигнатуру (у них 7 полей slot0 и свой набор событий), либо
// своп идёт через другой пул Pancake.
//
// Разбираем одну транзакцию по всем логам: адрес контракта, topic0, длина
// data. Так видно всё, без догадок.
import { createPublicClient, http, keccak256, toHex } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const LABELS = {
  '0x37c7702b589c69d1e4f4ad32e19f372ed6780278': 'НАШ пул',
  '0x36696169c63e42cd08ce11f5deebbecbae652050': 'Pancake 0.05%',
  '0x172fcd41e0913e95784454622d1c3724f546f849': 'Pancake 0.01%',
  '0x10ed43c718714eb63d5aa57b78b54704e256024e': 'Pancake V2 Router',
  '0x13f4ea83d0bd40e75c8222255bc855a974568dd4': 'Pancake V3 SmartRouter',
  '0xf98b7f4effb34dae1f785010ecf71ff796e7fdd1': 'НАШ V3 Router',
  '0x55d398326f99059ff775485246999027b3197955': 'USDT',
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': 'WBNB',
}

// Находим транзакцию, где в нашем пуле был своп С ПОЛОЖИТЕЛЬНЫМ amount0.
const head = await client.getBlockNumber()
let target = null
for (let i = 0; i < 20 && !target; i++) {
  const toBlock = head - BigInt(i) * 400n
  const fromBlock = toBlock - 399n
  try {
    const logs = await client.getLogs({ address: POOL, topics: [SWAP_TOPIC], fromBlock, toBlock })
    for (const l of logs) {
      if (l.address.toLowerCase() !== POOL.toLowerCase()) continue
      target = l.transactionHash
      break
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 120))
}
if (!target) {
  console.log('  транзакция не найдена')
  process.exit(0)
}

console.log('  транзакция:', target)
const tx = await client.getTransaction({ hash: target })
const r = await client.getTransactionReceipt({ hash: target })
console.log('  to (кого вызвали):', tx.to, '—', LABELS[tx.to?.toLowerCase()] ?? 'неизвестно')
console.log('  газ:', r.gasUsed.toString())
console.log('  логов:', r.logs.length)
console.log('')
console.log('  адрес контракта                            topic0 (событие)                                                     data')
for (const log of r.logs) {
  const addr = log.address.toLowerCase()
  const label = LABELS[addr] ?? log.address
  const t0 = log.topics[0] ?? '(анонимное)'
  const known = t0 === SWAP_TOPIC ? 'Swap' : ''
  console.log(`  ${label.padEnd(42)} ${t0.slice(0, 20)}…  topics=${log.topics.length} data=${(log.data.length - 2) / 2}b ${known}`)
}
// Кто торгует в нашем пуле: бот сам с собой или приходят снаружи.
//
// Это решает всё. Если объём создаёт только бот, то и расхождения цены с
// рынком не возникает — а без расхождения арбитражу нечего забирать. Тогда
// «привлечь арбитраж» невозможно в принципе, пока нет чужого потока.
//
// В событии Swap у нас indexed sender и recipient:
//   topic0 = хэш события
//   topic1 = sender  (кто вызвал swap)
//   topic2 = recipient (кому ушёл выход)
// Смотрим узкими окнами: публичные RPC режут широкий eth_getLogs.
import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const OUR_ROUTER = '0xf98b7f4effb34dae1f785010ecf71ff796e7fdd1'
const BOT = '0x922598c9D529836b4b475cE74188D5EeFFb83a88'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const head = await client.getBlockNumber()
console.log('  head =', head.toString())

// Узкие окна: 400 блоков × 40 = 16 000 блоков ≈ 2 часа при 0.45 с.
const WINDOW = 400n
const ROUNDS = 40

const senders = new Map()
let swaps = 0
let blocksScanned = 0

for (let i = 0; i < ROUNDS; i++) {
  const toBlock = head - BigInt(i) * WINDOW
  const fromBlock = toBlock - WINDOW + 1n
  try {
    const logs = await client.getLogs({ address: POOL, topics: [SWAP_TOPIC], fromBlock, toBlock })
    blocksScanned += Number(WINDOW)
    for (const l of logs) {
      if (l.address.toLowerCase() !== POOL.toLowerCase()) continue
      if (l.topics[0] !== SWAP_TOPIC) continue
      if (l.topics.length < 3) continue
      const sender = '0x' + l.topics[1].slice(26)
      senders.set(sender, (senders.get(sender) ?? 0) + 1)
      swaps++
    }
  } catch {
    // окно не отдалось — пропускаем, это норма для публичного RPC
  }
  await new Promise((r) => setTimeout(r, 120))
}

console.log(`  просмотрено блоков: ${blocksScanned}, свопов найдено: ${swaps}`)
console.log('')
if (senders.size === 0) {
  console.log('  Свопов в окне не найдено.')
  console.log('  Либо пул не торгуется, либо RPC не отдал логи.')
} else {
  console.log('  кто инициировал свопы:')
  for (const [addr, n] of [...senders.entries()].sort((a, b) => b[1] - a[1])) {
    let label = 'неизвестный контракт/кошелёк'
    if (addr.toLowerCase() === OUR_ROUTER.toLowerCase()) label = 'НАШ роутер'
    else if (addr.toLowerCase() === BOT.toLowerCase()) label = 'кошелёк БОТА напрямую'
    console.log(`    ${addr}  ${String(n).padStart(4)} свопов  — ${label}`)
  }
}
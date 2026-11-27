// Чей это объём: внешний поток или сам бот гоняет свои же деньги.
//
// Это решает, есть ли смысл в пуле вообще. Если весь объём создаёт бот
// (свопы собственных денег туда-обратно), то комиссии он платит сам себе,
// а внешнего дохода нет. Если объём внешний — пул работает.
//
// Как различить: у бота адрес известен, и его роутер тоже. Смотрим, сколько
// объёма идёт через них, а сколько — от прочих адресов.
import { createPublicClient, http, parseAbi, decodeAbiParameters, parseAbiParameters } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const BOT = '0x922598c9D529836b4b475cE74188D5EeFFb83a88'
const OUR_V3_ROUTER = '0xf98b7f4effb34dae1f785010ecf71ff796e7fdd1'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const head = await client.getBlockNumber()
const WINDOW = 400n
const ROUNDS = 100

const bySender = new Map() // sender -> { usd, count }
let total = 0

for (let i = 0; i < ROUNDS; i++) {
  const toBlock = head - BigInt(i) * WINDOW
  const fromBlock = toBlock - WINDOW + 1n
  try {
    const logs = await client.getLogs({ address: POOL, topics: [SWAP_TOPIC], fromBlock, toBlock })
    for (const l of logs) {
      if (l.address.toLowerCase() !== POOL.toLowerCase()) continue
      if (l.topics.length < 3) continue
      const sender = ('0x' + l.topics[1].slice(26)).toLowerCase()
      let usdt = 0
      try {
        const d = decodeAbiParameters(
          parseAbiParameters('int256 amount0, int256 amount1, uint160, uint128, int24'),
          l.data,
        )
        usdt = Number(d[0] < 0n ? -d[0] : d[0]) / 1e18
      } catch { continue }
      if (!bySender.has(sender)) bySender.set(sender, { usd: 0, count: 0 })
      const e = bySender.get(sender)
      e.usd += usdt
      e.count += 1
      total += usdt
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 100))
}

console.log(`  всего объёма за окно: $${total.toFixed(2)}   отправителей: ${bySender.size}`)
console.log('')
console.log('  отправитель                                объём($)   свопов   доля')
const rows = [...bySender.entries()].sort((a, b) => b[1].usd - a[1].usd)
for (const [addr, e] of rows) {
  let tag = ''
  if (addr === BOT.toLowerCase()) tag = ' ← БОТ'
  else if (addr === OUR_V3_ROUTER.toLowerCase()) tag = ' ← НАШ роутер'
  const share = total > 0 ? (e.usd / total * 100).toFixed(1) : '0'
  console.log(`  ${addr}  ${e.usd.toFixed(2).padStart(9)}  ${String(e.count).padStart(6)}   ${share.padStart(5)}%${tag}`)
}

console.log('')
const botVol = bySender.get(BOT.toLowerCase())?.usd ?? 0
const routerVol = bySender.get(OUR_V3_ROUTER.toLowerCase())?.usd ?? 0
console.log('=== ВЫВОД ===')
console.log(`  через кошелёк бота напрямую: $${botVol.toFixed(2)}`)
console.log(`  через наш роутер:            $${routerVol.toFixed(2)}`)
console.log(`  от прочих (внешние):         $${(total - botVol - routerVol).toFixed(2)}`)
console.log('')
const external = total - botVol - routerVol
if (external / total > 0.9) {
  console.log('  Практически весь объём — ВНЕШНИЙ. Пул работает на чужом потоке.')
  console.log('  Это хорошая новость: значит комиссии приходят снаружи, а не')
  console.log('  перекладываются ботом из кармана в карман.')
} else if (botVol / total > 0.5) {
  console.log('  Больше половины объёма — сам бот. Комиссии он платит себе же.')
} else {
  console.log('  Объём распределён: есть и внешний, и ботовый.')
}
// Что за свопы идут в пуле: суммы, направления, арбитраж это или нет.
//
// Предыдущий скрипт показал 23 свопа за 16 000 блоков от адресов, которых мы
// не знаем. Это меняет картину: значит кто-то пул всё-таки нашёл. Надо понять
// кто и зачем, прежде чем советовать что-то менять.
//
// Swap у нас: sender и recipient indexed, в data —
//   int256 amount0, int256 amount1, uint160 sqrtPriceX96,
//   uint128 liquidity, int24 tick
// Знак amount — направление: отрицательный = ушло из пула.
import { createPublicClient, http, parseAbi, decodeAbiParameters, parseAbiParameters, formatUnits } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const codeAbi = parseAbi(['function balanceOf(address) view returns (uint256)'])

const head = await client.getBlockNumber()
const WINDOW = 400n
const ROUNDS = 40

const rows = []
const senders = new Set()

for (let i = 0; i < ROUNDS; i++) {
  const toBlock = head - BigInt(i) * WINDOW
  const fromBlock = toBlock - WINDOW + 1n
  try {
    const logs = await client.getLogs({ address: POOL, topics: [SWAP_TOPIC], fromBlock, toBlock })
    for (const l of logs) {
      if (l.address.toLowerCase() !== POOL.toLowerCase()) continue
      if (l.topics[0] !== SWAP_TOPIC || l.topics.length < 3) continue
      const sender = '0x' + l.topics[1].slice(26)
      senders.add(sender.toLowerCase())
      let a0, a1, tick
      try {
        const d = decodeAbiParameters(
          parseAbiParameters('int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick'),
          l.data,
        )
        a0 = d[0]; a1 = d[1]; tick = Number(d[4])
      } catch {
        continue
      }
      rows.push({ block: l.blockNumber, tx: l.transactionHash, sender, a0, a1, tick })
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 110))
}

console.log(`  свопов разобрано: ${rows.length}, уникальных отправителей: ${senders.size}`)
console.log('')

// Проверяем, есть ли у отправителей код: контракт = вероятный бот.
console.log('=== КТО ЭТО ===')
for (const s of senders) {
  const code = await client.getCode({ address: s })
  const isContract = code && code !== '0x'
  console.log(`  ${s}  ${isContract ? 'КОНТРАКТ (бот/агрегатор)' : 'обычный кошелёк'}`)
}

console.log('')
console.log('=== ПОСЛЕДНИЕ СВОПЫ ===')
console.log('  блок      направление            amount0(USDT)     amount1(WBNB)    tick')
for (const r of rows.slice(0, 15)) {
  const dir = r.a0 < 0n ? 'USDT из пула →' : 'USDT в пул  →'
  const usdt = Number(r.a0 < 0n ? -r.a0 : r.a0) / 1e18
  const wbnb = Number(r.a1 < 0n ? -r.a1 : r.a1) / 1e18
  console.log(`  ${String(r.block).padEnd(10)} ${dir.padEnd(18)} ${usdt.toFixed(2).padStart(12)} ${wbnb.toFixed(6).padStart(14)}  ${r.tick}`)
}

// Ищем пары «туда-обратно» в пределах нескольких блоков — признак арбитража.
console.log('')
console.log('=== ПРИЗНАКИ АРБИТРАЖА (разворот в пределах 5 блоков) ===')
let found = 0
for (let i = 0; i < rows.length; i++) {
  for (let j = i + 1; j < rows.length; j++) {
    const a = rows[i], b = rows[j]
    if (b.block - a.block > 5n) break
    const opposite = (a.a0 < 0n) !== (b.a0 < 0n)
    if (opposite) {
      console.log(`  блоки ${a.block} и ${b.block} (Δ${b.block - a.block}), отправители ${a.sender.slice(0, 10)}… / ${b.sender.slice(0, 10)}…`)
      found++
      if (found >= 8) break
    }
  }
  if (found >= 8) break
}
if (found === 0) console.log('  разворотов в пределах 5 блоков не найдено')
// Хронология: когда бот разложил ступени относительно нашего перевода.
//
// В документе утверждается «бот уже разложил средства тремя ступенями» — но
// это надо проверить по блокам, а не на глаз. Если ступени появились ДО
// нашего перевода, значит бот потратил свои прежние деньги и наше пополнение
// ещё не тронуто. Если ПОСЛЕ — он уже вложил именно наши 39 USDT.
//
// Разница важна: во втором случае перевод боту уже отработан, и просить его
// «добавить средства» не нужно.
import { createPublicClient, http, parseAbi, keccak256, encodePacked } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const BOT = '0x922598c9D529836b4b475cE74188D5EeFFb83a88'
const MINT_TOPIC = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'

// Наши транзакции из предыдущего шага.
const OUR_TXS = {
  '0x7fad71406d6448d84caaac43a520d4ab0229c220a57679255b42b6c31ce42f24': 'газ с зеркала',
  '0x5360b38305b38119d570f393217e7071460bad0f4806de1e0874114405291493': 'наш burn',
  '0x685e1bb845dab3a1e0a72d1a5702c6c187494efa36f6d3151cc255e3ef34e066': 'transfer USDT',
  '0xbf95c00f4ff2b886ee1a228af21b820b6cebe3618c719dfccd3a804f2bba6968': 'transfer WBNB',
}

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const abi = parseAbi([
  'function positions(bytes32) view returns (uint128, uint256, uint256, uint128, uint128, uint128, uint128, uint256)',
])

console.log('=== НАШИ ТРАНЗАКЦИИ ===')
const ourBlocks = {}
for (const [hash, label] of Object.entries(OUR_TXS)) {
  const tx = await client.getTransaction({ hash })
  console.log(`  ${label.padEnd(14)} блок ${tx.blockNumber}`)
  ourBlocks[label] = tx.blockNumber
}

const startAfter = Object.values(ourBlocks).reduce((a, b) => (a > b ? a : b))
console.log('  последняя наша   :', startAfter.toString())

// Ищем Mint в узком окне после нашего перевода.
console.log('\n=== MINT ПОСЛЕ НАШЕГО ПЕРЕВОДА ===')
const RANGES = [[-63740, -63540], [-63540, -63130], [-63140, -62930]]

let found = 0
for (let w = 0; w < 40 && found < 6; w++) {
  const fromBlock = startAfter - 200n + BigInt(w) * 1000n
  const toBlock = fromBlock + 999n
  let logs = []
  try {
    logs = await client.getLogs({ address: POOL, topics: [MINT_TOPIC], fromBlock, toBlock })
  } catch {
    await new Promise((r) => setTimeout(r, 250))
    continue
  }
  for (const l of logs) {
    if (l.topics.length !== 4) continue
    const owner = '0x' + l.topics[1].slice(26)
    if (owner.toLowerCase() !== BOT.toLowerCase()) continue
    const lower = Number(BigInt.asIntN(24, BigInt(l.topics[2])))
    const upper = Number(BigInt.asIntN(24, BigInt(l.topics[3])))
    const when = l.blockNumber > startAfter ? 'ПОСЛЕ нашего перевода' : 'ДО нашего перевода'
    console.log(`  блок ${l.blockNumber}  ${lower}..${upper}  ${when}`)
    found++
  }
  await new Promise((r) => setTimeout(r, 200))
}
if (found === 0) console.log('  Mint бота в окне не попались (RPC может резать getLogs)')

// Более надёжно: читаем ликвидность и балансы — они скажут сами.
console.log('\n=== ТЕКУЩЕЕ СОСТОЯНИЕ ===')
for (const [lo, hi] of RANGES) {
  const key = keccak256(encodePacked(['address', 'int24', 'int24'], [BOT, lo, hi]))
  const p = await client.readContract({ address: POOL, abi, functionName: 'positions', args: [key] })
  console.log(`  ${lo}..${hi}: L=${p[0]}  vest=${p[7]}`)
}
const bal = await client.getBalance({ address: BOT })
console.log('  BNB у бота:', Number(bal) / 1e18)
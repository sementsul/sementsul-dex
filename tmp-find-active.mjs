// Найти активную позицию через события Mint.
//
// Перебор пар границ дорог (десятки тысяч запросов). События Mint дают
// готовые (owner, tickLower, tickUpper) — остаётся проверить, жива ли позиция.
//
// Ловушка публичных RPC: фильтр по topic0 может игнорироваться, а широкое
// окно eth_getLogs отклоняется. Поэтому идём узкими окнами и проверяем
// форму лога, а не доверяем фильтру.
import { createPublicClient, http, parseAbi, keccak256, encodePacked, decodeAbiParameters, parseAbiParameters } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const MINT_TOPIC = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const abi = parseAbi([
  'function positions(bytes32) view returns (uint128, uint256, uint256, uint128, uint128, uint128, uint128, uint256)',
])

const head = await client.getBlockNumber()
console.log('  head =', head.toString())

const span = 5000n
const seen = new Map()
for (let w = 0; w < 60; w++) {
  const toBlock = head - BigInt(w) * span
  const fromBlock = toBlock - span
  if (fromBlock < 1n) break
  let logs = []
  try {
    logs = await client.getLogs({ address: POOL, topics: [MINT_TOPIC], fromBlock, toBlock })
  } catch {
    continue
  }
  for (const l of logs) {
    if (l.topics.length !== 4 || l.topics[0] !== MINT_TOPIC) continue
    const owner = '0x' + l.topics[1].slice(26)
    const lower = Number(BigInt.asIntN(24, BigInt(l.topics[2])))
    const upper = Number(BigInt.asIntN(24, BigInt(l.topics[3])))
    seen.set(`${owner}:${lower}:${upper}`, { owner, lower, upper })
  }
  await new Promise((r) => setTimeout(r, 60))
}

console.log('  уникальных минтов:', seen.size)
for (const { owner, lower, upper } of seen.values()) {
  const key = keccak256(encodePacked(['address', 'int24', 'int24'], [owner, lower, upper]))
  const p = await client.readContract({ address: POOL, abi, functionName: 'positions', args: [key] })
  const live = p[0] > 0n ? 'ЖИВА' : 'закрыта'
  console.log(`  ${owner.slice(0, 10)}… ${lower}..${upper}  L=${p[0]}  ${live}`)
  if (p[0] > 0n) {
    console.log(`    owed0=${p[3]} owed1=${p[4]} pend0=${p[5]} pend1=${p[6]} vest=${p[7]}`)
  }
}
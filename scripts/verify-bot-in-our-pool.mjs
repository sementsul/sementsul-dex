// Тщательная проверка: действительно ли бот держит позиции в НАШЕМ пуле.
//
// Сомнение возникло не на пустом месте. Код бота минтует через NFT-менеджер
// Pancake (ADDR.npm), а это создаёт позицию в пуле Pancake, а не в нашем.
// При этом поиск по событиям Mint показал «позиции бота в нашем пуле».
//
// Объяснение может быть простым: публичный RPC иногда игнорирует фильтр по
// адресу и отдаёт события со всех контрактов. Тогда я декодировал Mint из
// чужого пула и выдал их за наши. Проверяем адрес каждого лога и сверяем
// с прямым чтением positions().
import { createPublicClient, http, parseAbi, keccak256, encodePacked } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const PANCAKE_POOL = '0x36696169C63e42cd08ce11f5deeBbCeBae652050'
const MINT_TOPIC = '0x7a53080ba414158be7ec69b987b5fb7d07dee101fe85488f0853ae16239d0bde'
const BOT = '0x922598c9D529836b4b475cE74188D5EeFFb83a88'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const abi = parseAbi([
  'function positions(bytes32) view returns (uint128, uint256, uint256, uint128, uint128, uint128, uint128, uint256)',
  'function liquidity() view returns (uint128)',
])

const head = await client.getBlockNumber()
console.log('  head =', head.toString())
console.log('  наш пул     :', POOL)
console.log('  пул Pancake :', PANCAKE_POOL)
console.log('')

// Берём последние 25 000 блоков одним окном по КАЖДОМУ пулу отдельно.
const fromBlock = head - 25_000n
for (const [label, addr] of [['НАШ', POOL], ['Pancake', PANCAKE_POOL]]) {
  let logs = []
  try {
    logs = await client.getLogs({ address: addr, topics: [MINT_TOPIC], fromBlock, toBlock: head })
  } catch (e) {
    console.log(`  ${label}: getLogs не прошёл — ${String(e.shortMessage || e.message).slice(0, 80)}`)
    continue
  }
  const wrongAddr = logs.filter((l) => l.address.toLowerCase() !== addr.toLowerCase())
  console.log(`  ${label}: логов ${logs.length}, из них с чужим адресом ${wrongAddr.length}`)
  if (wrongAddr.length) {
    console.log(`    ПРИМЕР чужого адреса: ${wrongAddr[0].address}`)
  }

  const seen = new Map()
  for (const l of logs) {
    if (l.topics.length !== 4) continue
    if (l.address.toLowerCase() !== addr.toLowerCase()) continue
    const owner = '0x' + l.topics[1].slice(26)
    const lower = Number(BigInt.asIntN(24, BigInt(l.topics[2])))
    const upper = Number(BigInt.asIntN(24, BigInt(l.topics[3])))
    seen.set(`${owner}:${lower}:${upper}`, { owner, lower, upper })
  }
  for (const { owner, lower, upper } of seen.values()) {
    const key = keccak256(encodePacked(['address', 'int24', 'int24'], [owner, lower, upper]))
    const p = await client.readContract({ address: addr, abi, functionName: 'positions', args: [key] })
    const mark = owner.toLowerCase() === BOT.toLowerCase() ? ' <-- БОТ' : ''
    console.log(`    ${owner.slice(0, 10)}… ${lower}..${upper}  L=${p[0]}${mark}`)
  }
  console.log('')
}

// Прямая проверка: пул Pancake тоже спросим по ключу бота.
console.log('  перекрёстная проверка: наш пул по ключу бота')
for (const [lo, hi] of [[-63740, -63540], [-63540, -63130], [-63140, -62930]]) {
  const key = keccak256(encodePacked(['address', 'int24', 'int24'], [BOT, lo, hi]))
  const p = await client.readContract({ address: POOL, abi, functionName: 'positions', args: [key] })
  console.log(`    ${lo}..${hi}: L=${p[0]}`)
}
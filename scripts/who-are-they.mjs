// Кто эти контракты, которые уже торгуют в нашем пуле.
//
// Это ключевой вопрос. Я раньше сказал «пул не в маршрутизаторах, нас не
// находят» — а на цепи видно 23 свопа за 2 часа от восьми контрактов. Значит
// вывод был неверным, и надо понять реальную картину, а не свою гипотезу.
//
// Смотрим по каждому адресу: возраст (nonce), сколько газа тратит, какие
// ещё контракты вызывает в тех же транзакциях. По этому видно, MEV-бот это,
// агрегатор или что-то ещё.
import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'
const PANCAKE_005 = '0x36696169C63e42cd08ce11f5deeBbCeBae652050'
const PANCAKE_001 = '0x172fcD41E0913e95784454622d1c3724f546f849'
const OUR_ROUTER = '0xf98b7f4effb34dae1f785010ecf71ff796e7fdd1'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const head = await client.getBlockNumber()

// Собираем транзакции со свопами в нашем пуле.
const WINDOW = 400n
const ROUNDS = 40
const bySender = new Map()

for (let i = 0; i < ROUNDS; i++) {
  const toBlock = head - BigInt(i) * WINDOW
  const fromBlock = toBlock - WINDOW + 1n
  try {
    const logs = await client.getLogs({ address: POOL, topics: [SWAP_TOPIC], fromBlock, toBlock })
    for (const l of logs) {
      if (l.address.toLowerCase() !== POOL.toLowerCase()) continue
      if (l.topics[0] !== SWAP_TOPIC || l.topics.length < 3) continue
      const sender = ('0x' + l.topics[1].slice(26)).toLowerCase()
      if (!bySender.has(sender)) bySender.set(sender, [])
      bySender.get(sender).push(l.transactionHash)
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 110))
}

console.log('  отправителей:', bySender.size)
console.log('')

for (const [sender, txs] of bySender) {
  const code = await client.getCode({ address: sender })
  const nonce = await client.getTransactionCount({ address: sender })

  // Берём одну транзакцию и смотрим, к каким контрактам она обращалась.
  const tx = await client.getTransaction({ hash: txs[0] })
  const receipt = await client.getTransactionReceipt({ hash: txs[0] }).catch(() => null)

  // Какие известные пулы фигурируют в логах этой транзакции.
  const touched = new Set()
  if (receipt) {
    for (const log of receipt.logs) {
      const a = log.address.toLowerCase()
      if (a === POOL.toLowerCase()) touched.add('наш пул')
      else if (a === PANCAKE_005.toLowerCase()) touched.add('Pancake 0.05%')
      else if (a === PANCAKE_001.toLowerCase()) touched.add('Pancake 0.01%')
    }
  }

  console.log(`  ${sender}`)
  console.log(`    непустой код: ${code && code !== '0x' ? 'да, ' + ((code.length - 2) / 2) + ' байт' : 'нет (кошелёк)'}`)
  console.log(`    nonce (сколько транзакций отправил): ${nonce}`)
  console.log(`    свопов в нашем пуле: ${txs.length}`)
  console.log(`    газ в этой транзакции: ${receipt ? receipt.gasUsed.toString() : '?'}`)
  console.log(`    пулы в транзакции: ${[...touched].join(', ') || 'только наш'}`)
  console.log(`    to (контракт, который вызвали): ${tx.to}`)
  console.log('')
}
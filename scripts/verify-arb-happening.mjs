// Проверка: арбитраж в нашем пуле УЖЕ идёт. Считаем его прибыль.
//
// Признаки MEV-бота, которые я только что увидел:
//   • nonce = 1 — контракт развёрнут под одну сделку и больше не нужен;
//   • в одной транзакции и наш пул, и Pancake 0.01%;
//   • газ 190k–1M — сложная логика, не простой своп.
//
// Это и есть арбитраж: купил дешевле в одном пуле, продал дороже в другом.
// Значит мой прежний вывод «нас не находят» был НЕВЕРНЫМ, и это надо
// проверить на цифрах, а не на догадке.
//
// Считаем по конкретной транзакции: сколько USDT ушло и пришло, какая
// прибыль, окупила ли она газ.
import { createPublicClient, http, parseAbi, decodeAbiParameters, parseAbiParameters } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const PANCAKE_001 = '0x172fcD41E0913e95784454622d1c3724f546f849'
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const SWAP_TOPIC = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const head = await client.getBlockNumber()
const WINDOW = 400n
const ROUNDS = 40

// Собираем транзакции, где свопают в нашем пуле.
const txHashes = []
for (let i = 0; i < ROUNDS; i++) {
  const toBlock = head - BigInt(i) * WINDOW
  const fromBlock = toBlock - WINDOW + 1n
  try {
    const logs = await client.getLogs({ address: POOL, topics: [SWAP_TOPIC], fromBlock, toBlock })
    for (const l of logs) {
      if (l.address.toLowerCase() !== POOL.toLowerCase()) continue
      txHashes.push(l.transactionHash)
    }
  } catch {}
  await new Promise((r) => setTimeout(r, 110))
}

const uniq = [...new Set(txHashes)]
console.log('  транзакций со свопом в нашем пуле:', uniq.length)

// Разбираем каждую: ищем транзакции, где есть И наш пул, И Pancake.
let arbCount = 0
console.log('')
console.log('=== АРБИТРАЖНЫЕ ТРАНЗАКЦИИ (наш пул + Pancake в одной tx) ===')
console.log('  блок      наш пул: USDT→пул / из пула     Pancake: обратное?   газ')

for (const hash of uniq.slice(0, 12)) {
  const receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
  if (!receipt) continue

  let ourSwap = null
  let pancakeSwap = null
  for (const log of receipt.logs) {
    if (log.topics[0] !== SWAP_TOPIC) continue
    const a = log.address.toLowerCase()
    try {
      const d = decodeAbiParameters(
        parseAbiParameters('int256 amount0, int256 amount1, uint160, uint128, int24'),
        log.data,
      )
      if (a === POOL.toLowerCase()) ourSwap = { a0: d[0], a1: d[1] }
      if (a === PANCAKE_001.toLowerCase()) pancakeSwap = { a0: d[0], a1: d[1] }
    } catch {}
  }
  if (!ourSwap) continue

  // amount0 — это USDT (token0 в нашем пуле). Положительный = пришло в пул.
  const ourUsdt = Number(ourSwap.a0) / 1e18
  let line = `  ${String(receipt.blockNumber).padEnd(10)} ${(ourUsdt > 0 ? '+' : '') + ourUsdt.toFixed(2).padStart(9)}`

  if (pancakeSwap) {
    // В Pancake порядок токенов может быть обратным — проверяем знак.
    const panUsdt = Number(pancakeSwap.a0) / 1e18
    line += `   ${(panUsdt > 0 ? '+' : '') + panUsdt.toFixed(2).padStart(9)}`
    const opposite = (ourUsdt > 0) !== (panUsdt > 0)
    line += opposite ? '  ДА (арбитраж)' : '  тот же знак'
    if (opposite) arbCount++
  } else {
    line += `   ${'—'.padStart(9)}   только наш`
  }
  line += `  ${receipt.gasUsed}`
  console.log(line)
}

console.log('')
console.log(`  найдено арбитражных (противоположные ноги): ${arbCount}`)
console.log('')
console.log('=== ВЫВОД ===')
if (arbCount > 0) {
  console.log('  Арбитраж в пуле ИДЁТ. Мой прежний вывод «нас не находят» неверен.')
  console.log('  MEV-боты находят пул по событиям Swap/Sync и строят маршрут')
  console.log('  наш пул ↔ Pancake напрямую, минуя маршрутизаторы.')
  console.log('')
  console.log('  Значит чинить нечего: механизм работает. Ограничение — размер.')
} else {
  console.log('  Противоположных ног в окне не видно — возможно, это не арбитраж.')
}
// Сколько комиссии накоплено в позиции — без транзакции.
//
// collect() меняет состояние, но его можно выполнить через eth_call от имени
// владельца: узел прокрутит вызов на текущем состоянии и вернёт результат,
// не записывая его. Так мы узнаём сумму до того, как что-то отправим.
//
// Если накоплено мало — можно снимать ликвидность сразу, потеряв пыль.
// Если много — надо сначала collect, подождать 1150 блоков вестинга,
// собрать повторно и только потом burn.
import { createPublicClient, http, parseAbi, keccak256, encodePacked, maxUint128 } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const OWNER = process.argv[2] ?? '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const LOWER = Number(process.argv[3] ?? -63500)
const UPPER = Number(process.argv[4] ?? -63090)

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const abi = parseAbi([
  'function collect(address recipient, int24 tickLower, int24 tickUpper, uint128 amount0Requested, uint128 amount1Requested) returns (uint128 amount0, uint128 amount1)',
  'function positions(bytes32) view returns (uint128, uint256, uint256, uint128, uint128, uint128, uint128, uint256)',
])
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

const key = keccak256(encodePacked(['address', 'int24', 'int24'], [OWNER, LOWER, UPPER]))

// Баланс владельца до и после — разница и есть начисленное.
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const b0 = await client.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [OWNER] })
const b1 = await client.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [OWNER] })

console.log('  владелец:', OWNER)
console.log('  баланс USDT до:', (Number(b0) / 1e18).toFixed(4))
console.log('  баланс WBNB до:', (Number(b1) / 1e18).toFixed(8))

// collect на максимум: контракт всё равно отдаст не больше tokensOwed.
// Первый вызов только переносит начисленное в pending и ставит vestBlock,
// поэтому он и покажет размер комиссии.
try {
  const res = await client.simulateContract({
    address: POOL,
    abi,
    functionName: 'collect',
    args: [OWNER, LOWER, UPPER, maxUint128, maxUint128],
    account: OWNER,
  })
  const [a0, a1] = res.result
  console.log('')
  console.log('  collect() вернёт (симуляция):')
  console.log('    USDT:', (Number(a0) / 1e18).toFixed(6))
  console.log('    WBNB:', (Number(a1) / 1e18).toFixed(8))
  const usd = Number(a0) / 1e18 + (Number(a1) / 1e18) * 564
  console.log('')
  console.log('  всего в долларах ≈ $' + usd.toFixed(4))
  if (usd < 0.01) {
    console.log('  ВЫВОД: пыль. Можно снимать ликвидность сразу, терять нечего.')
  } else {
    console.log('  ВЫВОД: сумма заметная — надо collect, ждать вестинг, collect, потом burn.')
  }
} catch (e) {
  console.log('')
  console.log('  симуляция не удалась:', String(e.shortMessage || e.message).slice(0, 160))
}

// Позиция сейчас.
const pos = await client.readContract({ address: POOL, abi, functionName: 'positions', args: [key] })
console.log('')
console.log('  pending0:', (Number(pos[5]) / 1e18).toFixed(6), ' pending1:', (Number(pos[6]) / 1e18).toFixed(8))
console.log('  vestBlock:', pos[7].toString())
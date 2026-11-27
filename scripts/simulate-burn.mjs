// Сколько токенов освободит burn и сколько нужно газа.
//
// Симуляция через eth_call: узел прокручивает вызов на текущем состоянии и
// возвращает результат, ничего не записывая. Так узнаём точные суммы до
// отправки — иначе придётся гадать, а деньги настоящие.
import { createPublicClient, http, parseAbi, parseEther, formatEther, formatUnits, keccak256, encodePacked } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const OWNER = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const LOWER = -63500
const UPPER = -63090

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const abi = parseAbi([
  'function burn(int24 tickLower, int24 tickUpper, uint128 amount) returns (uint256, uint256)',
  'function positions(bytes32) view returns (uint128, uint256, uint256, uint128, uint128, uint128, uint128, uint256)',
  'function slot0() view returns (uint160, int24, uint128, uint24, int24)',
])

const key = keccak256(encodePacked(['address', 'int24', 'int24'], [OWNER, LOWER, UPPER]))
const pos = await client.readContract({ address: POOL, abi, functionName: 'positions', args: [key] })
const liq = pos[0]
const slot0 = await client.readContract({ address: POOL, abi, functionName: 'slot0' })

console.log('  ликвидность:', liq.toString())
console.log('  текущий tick:', slot0[1], ' диапазон: -63500..-63090')
console.log('')

// Симуляция burn от имени владельца.
try {
  const res = await client.simulateContract({
    address: POOL, abi, functionName: 'burn',
    args: [LOWER, UPPER, liq],
    account: OWNER,
  })
  const [a0, a1] = res.result
  console.log('  burn() вернёт:')
  console.log('    USDT:', formatUnits(a0, 18))
  console.log('    WBNB:', formatUnits(a1, 18))
  const price = 1.0001 ** -Number(slot0[1])
  const usd = Number(a0) / 1e18 + (Number(a1) / 1e18) * price
  console.log('    всего ≈ $' + usd.toFixed(2))
} catch (e) {
  console.log('  симуляция не удалась:', String(e.shortMessage || e.message).slice(0, 200))
}

// Газ.
const gasPrice = await client.getGasPrice()
console.log('')
console.log('  gasPrice:', gasPrice.toString(), 'wei =', (Number(gasPrice) / 1e9).toFixed(4), 'gwei')
for (const [label, gas] of [['burn', 200_000n], ['transfer', 60_000n], ['всё вместе', 200_000n + 60_000n * 2n]]) {
  console.log(`  ${label.padEnd(12)}: ${gas} газа =`, formatEther(gas * gasPrice), 'BNB')
}

const bal = await client.getBalance({ address: OWNER })
console.log('')
console.log('  BNB у владельца:', formatEther(bal))
const need = 320_000n * gasPrice
console.log('  нужно минимум  :', formatEther(need))
console.log('  не хватает     :', bal >= need ? 'нет' : formatEther(need - bal) + ' BNB')
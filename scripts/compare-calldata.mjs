// Сравнение: calldata от encodeFunctionData (работает) против той, что
// собирает фронтенд вручную. Ищем расхождение.

import { encodeFunctionData } from 'viem'
import artifacts from '../src/contracts/artifacts.json' with { type: 'json' }
import deployments from '../src/contracts/deployments.js'
import { buildSwapTx, encodeV3Path } from '../src/lib/quote.js'

const WBNB = deployments.wbnb
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const ME = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const amountIn = 100_000_000_000_000_000n
const deadline = 1795660000n

const pathHex = '0x' + encodeV3Path([WBNB, USDT], [500])

// Эталон: viem кодирует по ABI нашего роутера.
const reference = encodeFunctionData({
  abi: artifacts.SementsulV3Router.abi,
  functionName: 'exactInputSingle',
  args: [{ path: pathHex, recipient: ME, amountIn, amountOutMinimum: 0n }, deadline],
})

// То, что собирает фронтенд.
const route = {
  path: [WBNB, USDT],
  hops: [{ protocol: 'v3', address: deployments.wbnbUsdtV3Pool, fee: 500 }],
  amounts: [amountIn, 0n],
  amountOut: 0n,
}
const mine = buildSwapTx({
  route, tokenIn: WBNB, tokenOut: USDT, recipient: ME, slippageBps: 100, deadlineSec: Math.floor(Number(deadline) - Date.now() / 1000),
}).data

console.log('эталон (viem):    ', reference.length, 'символов')
console.log('фронтенд:         ', mine.length, 'символов')
console.log('совпадают:', reference === mine)
console.log('')

const w = (h) => h.slice(10).match(/.{64}/g) ?? []
const a = w(reference)
const b = w(mine)
const n = Math.max(a.length, b.length)
console.log('слово | эталон                                                            | фронтенд')
for (let i = 0; i < n; i++) {
  const x = a[i] ?? '—'
  const y = b[i] ?? '—'
  const same = x === y ? '   ' : ' >>'
  console.log(String(i).padStart(5), same, x.slice(0, 64).padEnd(64), '|', (y ?? '').slice(0, 64))
}
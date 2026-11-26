// Проверка: calldata, которую собирает фронтенд, реально проходит через наш
// V3-роутер. Сравниваем со «старой» 8-польной формой, которая падала.

import {
  createPublicClient, http, formatUnits, keccak256, encodeAbiParameters,
  parseAbiParameters, toHex, decodeFunctionResult,
} from 'viem'
import { bsc } from 'viem/chains'
import artifacts from '../src/contracts/artifacts.json' with { type: 'json' }
import deployments from '../src/contracts/deployments.js'
import { buildSwapTx } from '../src/lib/quote.js'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const WBNB = deployments.wbnb
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const ROUTER = deployments.v3Router
const ME = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const amountIn = 100_000_000_000_000_000n // 0.1 WBNB

// Подменяем баланс и разрешение, чтобы откат не мог быть из-за средств.
const balanceSlot = (holder, slot) =>
  keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [holder, BigInt(slot)]))
const allowanceSlot = (owner, spender, slot) => {
  const inner = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [owner, BigInt(slot)]))
  return keccak256(encodeAbiParameters(parseAbiParameters('address, bytes32'), [spender, inner]))
}
const stateOverride = [
  {
    address: WBNB,
    stateDiff: [
      { slot: balanceSlot(ME, 3), value: toHex(100n * 10n ** 18n, { size: 32 }) },
      { slot: allowanceSlot(ME, ROUTER, 4), value: toHex(2n ** 256n - 1n, { size: 32 }) },
    ],
  },
]

// Собираем маршрут вручную в том виде, в каком его отдаёт quote().
const route = {
  path: [WBNB, USDT],
  hops: [{ protocol: 'v3', address: deployments.wbnbUsdtV3Pool, fee: 500 }],
  amounts: [amountIn, 0n],
  amountOut: 0n,
}

const tx = buildSwapTx({
  route,
  tokenIn: WBNB,
  tokenOut: USDT,
  recipient: ME,
  slippageBps: 100,
})

console.log('роутер :', tx.to)
console.log('вид    :', tx.kind)
console.log('calldata:', tx.data.slice(0, 10), '... длина', (tx.data.length - 2) / 2, 'байт')
console.log('')

const abi = artifacts.SementsulV3Router.abi
try {
  const res = await client.call({ to: tx.to, data: tx.data, account: ME, stateOverride })
  const out = decodeFunctionResult({ abi, functionName: 'exactInputSingle', data: res.data })
  console.log('РЕЗУЛЬТАТ: работает —', formatUnits(out, 18), 'USDT за 0.1 WBNB')
  const price = Number(formatUnits(out, 18)) / 0.1
  console.log('цена     : 1 WBNB =', price.toFixed(2), 'USDT')
} catch (e) {
  console.log('РЕЗУЛЬТАТ: откат —', (e.shortMessage ?? e.message).slice(0, 140))
}
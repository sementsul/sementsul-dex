// Итоговая проверка: обмен BNB -> USDT на нашей бирже через роутер.
// Используем eth_call с подменой баланса аккаунта (на нём 0.008 BNB).

import {
  createPublicClient, http, toHex, formatUnits, decodeFunctionResult,
} from 'viem'
import { bsc } from 'viem/chains'
import artifacts from '../src/contracts/artifacts.json' with { type: 'json' }
import deployments from '../src/contracts/deployments.js'
import { buildSwapTx } from '../src/lib/quote.js'
import { NATIVE } from '../src/lib/chain.js'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const ME = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const amountIn = 100_000_000_000_000_000n

const route = {
  path: [NATIVE, USDT],
  hops: [{ protocol: 'v3', address: deployments.wbnbUsdtV3Pool, fee: 500 }],
  amounts: [amountIn, 0n],
  amountOut: 0n,
}
const tx = buildSwapTx({ route, tokenIn: NATIVE, tokenOut: USDT, recipient: ME, slippageBps: 100 })

console.log('вид:', tx.kind, '| value:', formatUnits(tx.value, 18), 'BNB')
console.log('calldata:', (tx.data.length - 2) / 2, 'байт')
console.log('')

// Смотрим, сколько вызовов внутри multicall.
const body = tx.data.slice(10)
const words = body.match(/.{64}/g) ?? []
const count = parseInt(words[1], 16)
console.log('вызовов в multicall:', count)
for (let i = 0; i < count; i++) {
  const off = parseInt(words[2 + i], 16) / 32 + 2
  const lenWord = parseInt(words[off], 16)
  const sel = '0x' + (words[off + 1] ?? '').slice(0, 8)
  console.log(`  [${i}] селектор ${sel}, длина ${lenWord} байт`)
}
console.log('')

try {
  const res = await client.call({
    to: tx.to,
    data: tx.data,
    account: ME,
    value: tx.value,
    stateOverride: [{ address: ME, balance: toHex(10n * 10n ** 18n, { size: 32 }) }],
  })
  console.log('РЕЗУЛЬТАТ: работает, ответ', (res.data.length - 2) / 2, 'байт')
} catch (e) {
  console.log('РЕЗУЛЬТАТ: откат —', (e.shortMessage ?? e.message).slice(0, 200))
}
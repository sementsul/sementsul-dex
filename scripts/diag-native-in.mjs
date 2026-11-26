// Почему падает обмен BNB -> USDT через наш роутер.
// Внутри multicall([exactInputSingle, refundBNB]) с value.

import {
  createPublicClient, http, keccak256, encodeAbiParameters,
  parseAbiParameters, toHex, formatUnits, decodeFunctionResult,
} from 'viem'
import { bsc } from 'viem/chains'
import artifacts from '../src/contracts/artifacts.json' with { type: 'json' }
import deployments from '../src/contracts/deployments.js'
import { buildSwapTx } from '../src/lib/quote.js'
import { NATIVE } from '../src/lib/chain.js'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const WBNB = deployments.wbnb
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

console.log('вид      :', tx.kind)
console.log('value    :', tx.value?.toString(), 'wei =', formatUnits(tx.value ?? 0n, 18), 'BNB')
console.log('calldata :', (tx.data.length - 2) / 2, 'байт')
console.log('')

// Смотрим, что лежит внутри multicall.
const body = tx.data.slice(10)
const words = body.match(/.{64}/g) ?? []
console.log('первые слова calldata:')
words.slice(0, 8).forEach((w, i) => console.log(`  [${i}] 0x${w}`))

// Пробуем вызвать напрямую, подменив баланс.
try {
  const res = await client.call({
    to: tx.to,
    data: tx.data,
    account: ME,
    value: tx.value ?? 0n,
    stateOverride: [{ address: ME, balance: toHex(1000n * 10n ** 18n, { size: 32 }) }],
  })
  console.log('')
  console.log('РЕЗУЛЬТАТ: работает')
} catch (e) {
  console.log('')
  console.log('РЕЗУЛЬТАТ: откат —', (e.shortMessage ?? e.message).slice(0, 200))
}

// Проверим, есть ли у роутера функция wrapBNB и что делает refundBNB.
const abi = artifacts.SementsulV3Router.abi
const fns = abi.filter((x) => x.type === 'function').map((x) => x.name)
console.log('')
console.log('функции роутера:', fns.join(', '))
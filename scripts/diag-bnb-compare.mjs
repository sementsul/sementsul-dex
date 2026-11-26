// Проверяем последовательность целиком, но с реальным балансом WBNB на
// роутере: подменяем и баланс аккаунта (для value), и баланс роутера.

import {
  createPublicClient, http, toHex, formatUnits, keccak256,
  encodeAbiParameters, parseAbiParameters, parseAbi,
} from 'viem'
import { bsc } from 'viem/chains'
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

// Пробуем без stateOverride вообще — вдруг проблема в нём.
try {
  await client.call({ to: tx.to, data: tx.data, account: ME, value: tx.value })
  console.log('без override: проходит')
} catch (e) {
  console.log('без override: откат —', (e.shortMessage ?? e.message).slice(0, 120))
}

// С override баланса аккаунта.
try {
  await client.call({
    to: tx.to, data: tx.data, account: ME, value: tx.value,
    stateOverride: [{ address: ME, balance: toHex(10n * 10n ** 18n, { size: 32 }) }],
  })
  console.log('с override баланса: проходит')
} catch (e) {
  console.log('с override баланса: откат —', (e.shortMessage ?? e.message).slice(0, 120))
}

// Сравнение: WBNB -> USDT работает? (уже проверено, но для контраста)
const route2 = {
  path: [WBNB, USDT],
  hops: [{ protocol: 'v3', address: deployments.wbnbUsdtV3Pool, fee: 500 }],
  amounts: [amountIn, 0n],
  amountOut: 0n,
}
const tx2 = buildSwapTx({ route: route2, tokenIn: WBNB, tokenOut: USDT, recipient: ME, slippageBps: 100 })
const balanceSlot = (holder, slot) =>
  keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [holder, BigInt(slot)]))
const allowanceSlot = (owner, spender, slot) => {
  const inner = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [owner, BigInt(slot)]))
  return keccak256(encodeAbiParameters(parseAbiParameters('address, bytes32'), [spender, inner]))
}
try {
  await client.call({
    to: tx2.to, data: tx2.data, account: ME,
    stateOverride: [{
      address: WBNB,
      stateDiff: [
        { slot: balanceSlot(ME, 3), value: toHex(1000n * 10n ** 18n, { size: 32 }) },
        { slot: allowanceSlot(ME, tx2.to, 4), value: toHex(2n ** 256n - 1n, { size: 32 }) },
      ],
    }],
  })
  console.log('WBNB->USDT с override: проходит')
} catch (e) {
  console.log('WBNB->USDT с override: откат —', (e.shortMessage ?? e.message).slice(0, 120))
}
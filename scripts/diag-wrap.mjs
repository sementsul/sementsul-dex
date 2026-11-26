// Точная причина отката для BNB -> USDT: вызываем части по отдельности.

import {
  createPublicClient, http, keccak256, encodeAbiParameters,
  parseAbiParameters, toHex, formatUnits, parseAbi,
} from 'viem'
import { bsc } from 'viem/chains'
import artifacts from '../src/contracts/artifacts.json' with { type: 'json' }
import deployments from '../src/contracts/deployments.js'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const WBNB = deployments.wbnb
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const ROUTER = deployments.v3Router
const ME = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const amountIn = 100_000_000_000_000_000n

const abi = artifacts.SementsulV3Router.abi
const erc = parseAbi(['function balanceOf(address) view returns (uint256)'])

// 1. Проверяем, что wrapBNB работает сам по себе.
const { SEL } = await import('../src/lib/abi.js')
const encUint = (v) => BigInt(v).toString(16).padStart(64, '0')
const wrapData = SEL.wrapBNB + encUint(amountIn)

try {
  await client.call({
    to: ROUTER, data: wrapData, account: ME, value: amountIn,
    stateOverride: [{ address: ME, balance: toHex(100n * 10n ** 18n, { size: 32 }) }],
  })
  console.log('wrapBNB: проходит')
} catch (e) {
  console.log('wrapBNB: откат —', (e.shortMessage ?? e.message).slice(0, 150))
}

// 2. Проверяем селектор wrapBNB против байткода роутера.
const code = await client.getBytecode({ address: ROUTER })
for (const sig of ['wrapBNB(uint256)', 'refundBNB()', 'multicall(bytes[])']) {
  const s = keccak256(toHex(sig)).slice(0, 10)
  const hex = s.slice(2)
  console.log(`${sig.padEnd(20)} селектор ${s} -> ${code.toLowerCase().includes(hex) ? 'есть в коде' : 'НЕТ В КОДЕ'}`)
}

// 3. Пробуем BNB -> USDT БЕЗ refundBNB.
const { encodeV3Path, buildSwapTx } = await import('../src/lib/quote.js')
const pathHex = '0x' + encodeV3Path([WBNB, USDT], [500])
console.log('')
console.log('path:', pathHex, 'длина', (pathHex.length - 2) / 2)
// Почему BNB -> USDT падает: проверяем гипотезу, что внутри multicall
// delegatecall теряет msg.value (в delegatecall msg.value сохраняется, но
// wrapBNB вызывается через delegatecall — значит видит msg.value
// РОДИТЕЛЬСКОГО вызова, то есть multicall, а он payable). Проверяем
// последовательность по шагам: wrapBNB отдельно, потом обмен отдельно.

import {
  createPublicClient, http, keccak256, encodeAbiParameters,
  parseAbiParameters, toHex, formatUnits,
} from 'viem'
import { bsc } from 'viem/chains'
import artifacts from '../src/contracts/artifacts.json' with { type: 'json' }
import deployments from '../src/contracts/deployments.js'
import { SEL, encUint } from '../src/lib/abi.js'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const WBNB = deployments.wbnb
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const ROUTER = deployments.v3Router
const ME = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const amountIn = 100_000_000_000_000_000n

const { encodeV3Path, encodeExactInputSingleOwn } = await import('../src/lib/quote.js')

const pathHex = encodeV3Path([WBNB, USDT], [500])
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)

// Обмен как ERC-20: WBNB уже должен лежать на роутере.
const swapData = SEL.exactInputSingleOwn + encUint(0x40) + encUint(deadline) +
  encUint(0x80) + '0'.repeat(24) + ME.slice(2).toLowerCase() + encUint(amountIn) + encUint(0) +
  encUint(43) + pathHex.padEnd(128, '0')

console.log('swap calldata:', (swapData.length - 2) / 2, 'байт')
console.log('')

// Подменяем баланс WBNB у РОУТЕРА и проверяем, пройдёт ли обмен.
// Слот 3 у WBNB — balanceOf.
const balanceSlot = (holder, slot) =>
  keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [holder, BigInt(slot)]))

try {
  const res = await client.call({
    to: ROUTER,
    data: swapData,
    account: ME,
    stateOverride: [
      { address: WBNB, stateDiff: [{ slot: balanceSlot(ROUTER, 3), value: toHex(100n * 10n ** 18n, { size: 32 }) }] },
    ],
  })
  console.log('обмен при готовом WBNB на роутере: проходит')
} catch (e) {
  console.log('обмен при готовом WBNB на роутере: откат —', (e.shortMessage ?? e.message).slice(0, 140))
}

console.log('')
console.log('Вывод: если тут проходит, значит проблема только в порядке вызовов')
console.log('внутри multicall — wrapBNB должен идти ПЕРЕД обменом, и msg.value')
console.log('должен доходить до него через delegatecall.')
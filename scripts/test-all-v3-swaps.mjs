// Проверка всех веток V3-обмена: обычный, нативный BNB на входе и на выходе.

import {
  createPublicClient, http, formatUnits, keccak256, encodeAbiParameters,
  parseAbiParameters, toHex, decodeFunctionResult,
} from 'viem'
import { bsc } from 'viem/chains'
import artifacts from '../src/contracts/artifacts.json' with { type: 'json' }
import deployments from '../src/contracts/deployments.js'
import { buildSwapTx } from '../src/lib/quote.js'
import { NATIVE } from '../src/lib/chain.js'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const WBNB = deployments.wbnb
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const ROUTER = deployments.v3Router
const POOL = deployments.wbnbUsdtV3Pool
const ME = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const amountIn = 100_000_000_000_000_000n
const abi = artifacts.SementsulV3Router.abi

const balanceSlot = (holder, slot) =>
  keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [holder, BigInt(slot)]))
const allowanceSlot = (owner, spender, slot) => {
  const inner = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [owner, BigInt(slot)]))
  return keccak256(encodeAbiParameters(parseAbiParameters('address, bytes32'), [spender, inner]))
}
// Слоты balanceOf различаются: у WBNB это 3, у USDT — 1 (у него перед
// балансом лежит только minter-поле в другом порядке). allowance идёт
// следующим слотом за balanceOf в обоих.
const SLOTS = { [WBNB.toLowerCase()]: 3, [USDT.toLowerCase()]: 1 }

const overrides = (token, holder) => {
  const base = SLOTS[token.toLowerCase()]
  return [
    {
      address: token,
      stateDiff: [
        { slot: balanceSlot(holder, base), value: toHex(1000n * 10n ** 18n, { size: 32 }) },
        { slot: allowanceSlot(holder, ROUTER, base + 1), value: toHex(2n ** 256n - 1n, { size: 32 }) },
      ],
    },
  ]
}

const route = (tIn, tOut) => ({
  path: [tIn, tOut],
  hops: [{ protocol: 'v3', address: POOL, fee: 500 }],
  amounts: [amountIn, 0n],
  amountOut: 0n,
})

const cases = [
  ['WBNB -> USDT обычный', WBNB, USDT, overrides(WBNB, ME), 'v3-single', 'exactInputSingle'],
  ['USDT -> WBNB обратный', USDT, WBNB, overrides(USDT, ME), 'v3-single', 'exactInputSingle'],
  ['USDT -> BNB нативный выход', USDT, NATIVE, overrides(USDT, ME), 'v3-native-out', null],
]

for (const [label, tIn, tOut, stateOverride, expectKind, fn] of cases) {
  const tx = buildSwapTx({ route: route(tIn, tOut), tokenIn: tIn, tokenOut: tOut, recipient: ME, slippageBps: 100 })
  if (tx.kind !== expectKind) {
    console.log(`  ФЕЙЛ ${label}: вид ${tx.kind}, ожидался ${expectKind}`)
    continue
  }
  try {
    // eth_call проверяет, что value + газ покрываются балансом.
    const merged =
      tx.value > 0n
        ? [{ address: ME, balance: toHex(100n * 10n ** 18n, { size: 32 }) }, ...stateOverride]
        : stateOverride

    const res = await client.call({
      to: tx.to, data: tx.data, account: ME, value: tx.value ?? 0n, stateOverride: merged,
    })
    let out = '(multicall ok)'
    if (fn) out = formatUnits(decodeFunctionResult({ abi, functionName: fn, data: res.data }), 18) + ' USDT'
    console.log(`  ok   ${label} -> ${out}`)
  } catch (e) {
    console.log(`  ФЕЙЛ ${label} -> ${(e.shortMessage ?? e.message).slice(0, 80)}`)
  }
}

// BNB на входе: должно быть явное исключение, а не падающая транзакция.
try {
  buildSwapTx({ route: route(NATIVE, USDT), tokenIn: NATIVE, tokenOut: USDT, recipient: ME, slippageBps: 100 })
  console.log('  ФЕЙЛ BNB -> USDT: должен был отказать, но собрал транзакцию')
} catch (e) {
  console.log('  ok   BNB -> USDT: честно отказывает —', e.message.slice(0, 60) + '…')
}
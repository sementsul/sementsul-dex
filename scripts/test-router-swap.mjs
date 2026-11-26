// Проверка: работает ли обмен через наш V3-роутер.
//
// Фронтенд (src/lib/abi.js) кодирует exactInputSingle с сигнатурой Uniswap на
// 8 полей (селектор 0x414bf389), а наш роутер объявляет struct ExactInputParams
// из 4 полей (селектор 0xea7ec9c4). Проверяем оба варианта с подменой
// состояния: выдаём тестовому адресу баланс WBNB и разрешение роутеру, чтобы
// откат не мог быть вызван нехваткой средств.

import {
  createPublicClient,
  http,
  formatUnits,
  encodeFunctionData,
  decodeFunctionResult,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  toHex,
} from 'viem'
import { bsc } from 'viem/chains'
import artifacts from '../src/contracts/artifacts.json' with { type: 'json' }
import deployments from '../src/contracts/deployments.js'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const ROUTER = deployments.v3Router
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = deployments.wbnb
const ME = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const FEE = 500
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600)
const amountIn = 100_000_000_000_000_000n // 0.1 WBNB

const abi = artifacts.SementsulV3Router.abi

const path = '0x' + WBNB.toLowerCase().slice(2) + FEE.toString(16).padStart(6, '0') + USDT.toLowerCase().slice(2)

// Слоты WBNB: 3 — balanceOf, 4 — allowance (0 name, 1 symbol, 2 decimals).
const balanceSlot = (holder, slot) =>
  keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [holder, BigInt(slot)]))

const allowanceSlot = (owner, spender, slot) => {
  // keccak256(abi.encode(spender, keccak256(abi.encode(owner, slot))))
  // Порядок важен: spender идёт ПЕРВЫМ аргументом внешнего хеша.
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

async function attempt(label, data) {
  try {
    const res = await client.call({ to: ROUTER, data, account: ME, stateOverride })
    const out = decodeFunctionResult({ abi, functionName: 'exactInputSingle', data: res.data })
    console.log(`  ${label}: РАБОТАЕТ — ${formatUnits(out, 18)} USDT за 0.1 WBNB`)
  } catch (e) {
    console.log(`  ${label}: откат — ${(e.shortMessage ?? e.message).slice(0, 100)}`)
  }
}

console.log('роутер:', ROUTER)
console.log('')
console.log('=== 4-польная сигнатура (наш ABI) ===')
await attempt(
  'exactInputSingle',
  encodeFunctionData({
    abi,
    functionName: 'exactInputSingle',
    args: [{ path, recipient: ME, amountIn, amountOutMinimum: 0n }, deadline],
  })
)

console.log('')
console.log('=== 8-польная сигнатура (как шлёт фронтенд) ===')
const { SEL } = await import('../src/lib/abi.js')
console.log('  селектор фронтенда:', SEL.exactInputSingle)
const uniswapAbi = [
  {
    type: 'function',
    name: 'exactInputSingle',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'recipient', type: 'address' },
          { name: 'deadline', type: 'uint256' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'amountOutMinimum', type: 'uint256' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
]
await attempt(
  'exactInputSingle',
  encodeFunctionData({
    abi: uniswapAbi,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: WBNB,
        tokenOut: USDT,
        fee: FEE,
        recipient: ME,
        deadline,
        amountIn,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
)
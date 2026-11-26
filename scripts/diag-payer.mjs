// Причина отката BNB -> USDT.
//
// exactInputSingle вызывается внутри multicall через delegatecall. При
// delegatecall msg.sender НЕ меняется — им остаётся тот, кто вызвал
// multicall, то есть пользователь. Значит _pay получает payer = ME и делает
// transferFrom(ME, pool, owed) в токене WBNB.
//
// Но при входе в BNB пользователь не давал approve на WBNB: он прислал BNB,
// который wrapBNB положил на роутер. Роутер пытается списать WBNB с
// пользователя, у которого его нет. Отсюда откат.
//
// Проверяем гипотезу: если выдать ME approve на WBNB, обмен пройдёт.

import {
  createPublicClient, http, toHex, formatUnits, keccak256,
  encodeAbiParameters, parseAbiParameters,
} from 'viem'
import { bsc } from 'viem/chains'
import deployments from '../src/contracts/deployments.js'
import { buildSwapTx } from '../src/lib/quote.js'
import { NATIVE } from '../src/lib/chain.js'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const WBNB = deployments.wbnb
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const ME = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const ROUTER = deployments.v3Router
const amountIn = 100_000_000_000_000_000n

const route = {
  path: [NATIVE, USDT],
  hops: [{ protocol: 'v3', address: deployments.wbnbUsdtV3Pool, fee: 500 }],
  amounts: [amountIn, 0n],
  amountOut: 0n,
}
const tx = buildSwapTx({ route, tokenIn: NATIVE, tokenOut: USDT, recipient: ME, slippageBps: 100 })

const balanceSlot = (holder, slot) =>
  keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [holder, BigInt(slot)]))
const allowanceSlot = (owner, spender, slot) => {
  const inner = keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [owner, BigInt(slot)]))
  return keccak256(encodeAbiParameters(parseAbiParameters('address, bytes32'), [spender, inner]))
}

// Гипотеза: не хватает approve от ME на WBNB для роутера.
try {
  await client.call({
    to: tx.to, data: tx.data, account: ME, value: tx.value,
    stateOverride: [
      { address: ME, balance: toHex(10n * 10n ** 18n, { size: 32 }) },
      {
        address: WBNB,
        stateDiff: [
          { slot: balanceSlot(ME, 3), value: toHex(10n * 10n ** 18n, { size: 32 }) },
          { slot: allowanceSlot(ME, ROUTER, 4), value: toHex(2n ** 256n - 1n, { size: 32 }) },
        ],
      },
    ],
  })
  console.log('с approve WBNB от пользователя: ПРОХОДИТ')
  console.log('')
  console.log('=> Подтверждено: роутер списывает WBNB с ПОЛЬЗОВАТЕЛЯ (transferFrom),')
  console.log('   а не берёт завернутый BNB со своего баланса.')
  console.log('   Для входа в BNB это неверно: пользователь прислал BNB, у него нет WBNB.')
} catch (e) {
  console.log('с approve WBNB: откат —', (e.shortMessage ?? e.message).slice(0, 140))
  console.log('=> гипотеза неверна, причина в другом')
}
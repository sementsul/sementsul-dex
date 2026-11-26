// Почему откатывается обмен через наш роутер: разбираем по шагам.

import {
  createPublicClient, http, formatUnits, keccak256, encodeAbiParameters,
  parseAbiParameters, toHex, parseAbi,
} from 'viem'
import { bsc } from 'viem/chains'
import deployments from '../src/contracts/deployments.js'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const WBNB = deployments.wbnb
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const ROUTER = deployments.v3Router
const POOL = deployments.wbnbUsdtV3Pool
const ME = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'

const erc = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
])

// Пробуем подменить баланс и убедиться, что подмена видна.
const balanceSlot = (holder, slot) =>
  keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [holder, BigInt(slot)]))

for (const slot of [3n, 4n, 0n]) {
  const s = balanceSlot(ME, slot)
  try {
    const bal = await client.readContract({
      address: WBNB, abi: erc, functionName: 'balanceOf', args: [ME],
      stateOverride: [{ address: WBNB, stateDiff: [{ slot: s, value: toHex(100n * 10n ** 18n, { size: 32 }) }] }],
    })
    console.log(`слот ${slot} -> balanceOf = ${formatUnits(bal, 18)}`)
  } catch (e) {
    console.log(`слот ${slot} -> ошибка: ${(e.shortMessage ?? e.message).slice(0, 80)}`)
  }
}

console.log('')
console.log('реальный баланс WBNB:', formatUnits(await client.readContract({
  address: WBNB, abi: erc, functionName: 'balanceOf', args: [ME],
}), 18))
console.log('allowance на роутер :', formatUnits(await client.readContract({
  address: WBNB, abi: erc, functionName: 'allowance', args: [ME, ROUTER],
}), 18))

// Есть ли у пула ликвидность и жив ли он
const poolAbi = (await import('../src/contracts/artifacts.json', { with: { type: 'json' } })).default.SementsulV3Pool.abi
const slot0 = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'slot0' })
console.log('')
console.log('пул.sqrtPriceX96:', slot0[0].toString())
console.log('пул.liquidity  :', (await client.readContract({ address: POOL, abi: poolAbi, functionName: 'liquidity' })).toString())
console.log('пул.token0     :', await client.readContract({ address: POOL, abi: poolAbi, functionName: 'token0' }))
console.log('пул.token1     :', await client.readContract({ address: POOL, abi: poolAbi, functionName: 'token1' }))
console.log('пул.fee        :', (await client.readContract({ address: POOL, abi: poolAbi, functionName: 'fee' })).toString())
console.log('')
console.log('WBNB           :', WBNB)
console.log('USDT           :', USDT)
// Проверка слотов USDT: у него decimals=18, но раскладка storage может
// отличаться от WBNB. Находим слот balanceOf перебором.

import {
  createPublicClient, http, keccak256, encodeAbiParameters,
  parseAbiParameters, toHex, formatUnits, parseAbi,
} from 'viem'
import { bsc } from 'viem/chains'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const ME = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'

const erc = parseAbi(['function balanceOf(address) view returns (uint256)'])

const slotHash = (holder, slot) =>
  keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [holder, BigInt(slot)]))

for (const [name, token] of [['USDT', USDT], ['WBNB', WBNB]]) {
  console.log(`=== ${name} ===`)
  for (let slot = 0; slot < 10; slot++) {
    try {
      const bal = await client.readContract({
        address: token, abi: erc, functionName: 'balanceOf', args: [ME],
        stateOverride: [
          { address: token, stateDiff: [{ slot: slotHash(ME, slot), value: toHex(1000n * 10n ** 18n, { size: 32 }) }] },
        ],
      })
      if (bal > 0n) console.log(`  слот ${slot} -> ${formatUnits(bal, 18)}  <-- верный`)
    } catch { /* слот не тот */ }
  }
}
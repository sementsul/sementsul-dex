// Сколько NFT-позиций Pancake осталось у бота.
//
// Это влияет на совет: если бот ещё держит старые позиции в Pancake, у него
// два разных набора ABI и логики одновременно, и путаница между ними —
// источник ошибок. Читаем прямо с NFT-менеджера.
import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const NPM = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364'
const BOT = '0x922598c9D529836b4b475cE74188D5EeFFb83a88'

const abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
  'function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
])

const n = await client.readContract({ address: NPM, abi, functionName: 'balanceOf', args: [BOT] })
console.log('  NFT-позиций Pancake у бота:', n.toString())

for (let i = 0; i < Number(n) && i < 10; i++) {
  const id = await client.readContract({
    address: NPM, abi, functionName: 'tokenOfOwnerByIndex', args: [BOT, BigInt(i)],
  })
  const p = await client.readContract({ address: NPM, abi, functionName: 'positions', args: [id] })
  console.log(`    #${id}  ${p[5]}..${p[6]}  L=${p[7]}  owed=${p[10]}/${p[11]}`)
}
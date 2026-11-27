// Какие тиры включены в нашей фабрике и можно ли создать пул 0.01%.
//
// В документе предлагается перейти на тир 0.01% ради арбитража. Но тир
// должен быть включён в фабрике: tickSpacingFor[fee] != 0, иначе createPool
// откатится с FEE_NOT_ENABLED. Проверяем, что реально доступно.
import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'

const FACTORY = '0xc0b597bee57bba0aae2ce9e73e83217331a24dd9'
const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const abi = parseAbi([
  'function tickSpacingFor(uint24) view returns (int24)',
  'function jitDelayBlocks(uint24) view returns (uint32)',
  'function reversalPenaltyK(uint24) view returns (uint24)',
  'function getPool(address, address, uint24) view returns (address)',
])

const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

const TIERS = [50, 100, 500, 2500, 10000, 3000, 8000]
console.log('  тир    spacing  jitDelay  k          пул WBNB/USDT')
for (const fee of TIERS) {
  const [spacing, jit, k, pool] = await Promise.all([
    client.readContract({ address: FACTORY, abi, functionName: 'tickSpacingFor', args: [fee] }),
    client.readContract({ address: FACTORY, abi, functionName: 'jitDelayBlocks', args: [fee] }).catch(() => 0n),
    client.readContract({ address: FACTORY, abi, functionName: 'reversalPenaltyK', args: [fee] }).catch(() => 0n),
    client.readContract({ address: FACTORY, abi, functionName: 'getPool', args: [USDT, WBNB, fee] }).catch(() => '0x'),
  ])
  const enabled = Number(spacing) !== 0
  console.log(`  ${String(fee).padEnd(6)} ${String(spacing).padEnd(8)} ${String(jit).padEnd(9)} ${String(k).padEnd(10)} ${enabled ? (pool === '0x0000000000000000000000000000000000000000' ? 'не создан' : pool) : 'ТИР ВЫКЛЮЧЕН'}`)
}
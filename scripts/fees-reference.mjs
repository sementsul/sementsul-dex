// Справка по комиссиям для бота: цифры с цепи, а не из документа.
//
// Печатает всё, что нужно знать боту про комиссии в нашем пуле: тир, задержку
// вестинга, штраф за разворот, состояние позиции. Используется как источник
// для сообщения другой сессии.
import { createPublicClient, http, parseAbi, keccak256, encodePacked, maxUint128 } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const FACTORY = '0xc0b597bee57bba0aae2ce9e73e83217331a24dd9'
const BOT = '0x922598c9D529836b4b475cE74188D5EeFFb83a88'
const LOWER = -63500
const UPPER = -63090

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const poolAbi = parseAbi([
  'function slot0() view returns (uint160, int24, uint128, uint24, int24)',
  'function liquidity() view returns (uint128)',
  'function positions(bytes32) view returns (uint128 liquidity, uint256, uint256, uint128 tokensOwed0, uint128 tokensOwed1, uint128 pending0, uint128 pending1, uint256 vestBlock)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
  'function collect(address, int24, int24, uint128, uint128) returns (uint128, uint128)',
])
const factoryAbi = parseAbi([
  'function jitDelayBlocks(uint24) view returns (uint32)',
  'function reversalPenaltyK(uint24) view returns (uint24)',
  'function maxReversalPenalty() view returns (uint24)',
])

const slot0 = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'slot0' })
const fee = Number(slot0[3])
const jit = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'jitDelayBlocks', args: [fee] })
const k = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'reversalPenaltyK', args: [fee] })
const cap = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'maxReversalPenalty' })
const fg0 = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'feeGrowthGlobal0X128' })
const fg1 = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'feeGrowthGlobal1X128' })
const block = await client.getBlockNumber()

console.log('=== ПАРАМЕТРЫ ПУЛА ===')
console.log('  fee            :', fee, '=', fee / 10000, '%')
console.log('  tickSpacing    :', Number(slot0[4]))
console.log('  jitDelayBlocks :', jit.toString(), 'блоков ≈', (Number(jit) * 0.45 / 60).toFixed(1), 'мин')
console.log('  reversalPenaltyK:', k.toString())
console.log('  maxReversalPenalty:', cap.toString(), '=', Number(cap) / 1e4, '%')

console.log('\n=== ГЛОБАЛЬНЫЙ РОСТ КОМИССИИ ===')
console.log('  feeGrowthGlobal0X128:', fg0.toString())
console.log('  feeGrowthGlobal1X128:', fg1.toString())
console.log('  (это накопленный итог за всё время; позиция видит только разницу)')

console.log('\n=== ПОЗИЦИЯ БОТА В НАШЕМ ДИАПАЗОНЕ ===')
const key = keccak256(encodePacked(['address', 'int24', 'int24'], [BOT, LOWER, UPPER]))
const pos = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'positions', args: [key] })
console.log('  ликвидность :', pos[0].toString())
console.log('  tokensOwed0 :', Number(pos[3]) / 1e18, 'USDT')
console.log('  tokensOwed1 :', Number(pos[4]) / 1e18, 'WBNB')
console.log('  pending0    :', Number(pos[5]) / 1e18, 'USDT')
console.log('  pending1    :', Number(pos[6]) / 1e18, 'WBNB')
console.log('  vestBlock   :', pos[7].toString(), ' блок сейчас:', block.toString())
if (pos[7] > 0n) {
  console.log('  вестинг идёт:', pos[7] > block ? 'ДА, осталось ' + (pos[7] - block).toString() + ' блоков' : 'нет, истёк')
}

// Симуляция collect: сколько бот получит прямо сейчас.
console.log('\n=== ЧТО ДАСТ collect() ПРЯМО СЕЙЧАС ===')
try {
  const res = await client.simulateContract({
    address: POOL, abi: poolAbi, functionName: 'collect',
    args: [BOT, LOWER, UPPER, maxUint128, maxUint128], account: BOT,
  })
  console.log('  USDT:', Number(res.result[0]) / 1e18)
  console.log('  WBNB:', Number(res.result[1]) / 1e18)
} catch (e) {
  console.log('  не удалось:', String(e.shortMessage || e.message).slice(0, 120))
}
console.log('  ВАЖНО: первый collect только переносит начисленное в pending')
console.log('         и ставит vestBlock = block +', jit.toString(), '. Забрать — вторым вызовом.')
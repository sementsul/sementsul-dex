// Состояние нашей позиции в пуле перед снятием.
//
// Главное, что надо узнать до любой транзакции: сколько комиссии уже
// начислено (tokensOwed), сколько висит в вестинге (pending) и до какого
// блока он идёт. Если снять ликвидность до конца вестинга, pending сгорит
// пропорционально снятой доле — это не баг, а защита от JIT, и терять её
// молча нельзя.
import { createPublicClient, http, parseAbi, keccak256, encodePacked } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const FACTORY = '0xc0b597bee57bba0aae2ce9e73e83217331a24dd9'
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const poolAbi = parseAbi([
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160, int24, uint128, uint24, int24)',
  'function positions(bytes32) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1, uint128 pending0, uint128 pending1, uint256 vestBlock)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
])
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
const factoryAbi = parseAbi(['function jitDelayBlocks(uint24) view returns (uint32)'])

const OWNER = process.argv[2] ?? '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const LOWER = Number(process.argv[3] ?? -63500)
const UPPER = Number(process.argv[4] ?? -63090)

const key = keccak256(encodePacked(['address', 'int24', 'int24'], [OWNER, LOWER, UPPER]))
const pos = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'positions', args: [key] })
const slot0 = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'slot0' })
const totalLiq = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'liquidity' })
const jit = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'jitDelayBlocks', args: [500] })
const block = await client.getBlockNumber()

const [liq, , , owed0, owed1, pend0, pend1, vestBlock] = pos

console.log('  владелец :', OWNER)
console.log('  диапазон :', LOWER, '..', UPPER)
console.log('  ключ     :', key)
console.log('')
console.log('  ликвидность позиции :', liq.toString())
console.log('  ликвидность пула    :', totalLiq.toString())
console.log('  доля в пуле         :', totalLiq > 0n ? (Number(liq) / Number(totalLiq) * 100).toFixed(2) + '%' : '—')
console.log('')
console.log('  tokensOwed0 (USDT)  :', (Number(owed0) / 1e18).toFixed(6))
console.log('  tokensOwed1 (WBNB)  :', (Number(owed1) / 1e18).toFixed(8))
console.log('  pending0    (USDT)  :', (Number(pend0) / 1e18).toFixed(6))
console.log('  pending1    (WBNB)  :', (Number(pend1) / 1e18).toFixed(8))
console.log('  vestBlock           :', vestBlock.toString())
console.log('')
console.log('  блок сейчас         :', block.toString())
console.log('  jitDelayBlocks(500) :', jit.toString())
if (vestBlock > 0n) {
  const left = vestBlock > block ? vestBlock - block : 0n
  console.log('  до конца вестинга   :', left.toString(), 'блоков ≈', (Number(left) * 0.45 / 60).toFixed(1), 'мин')
  console.log('  ВЕСТИНГ ИДЁТ        :', left > 0n ? 'ДА — снятие сожжёт pending' : 'нет, всё зрелое')
} else {
  console.log('  вестинг не начат (vestBlock = 0) — pending ещё не переносили')
}

// Сколько токенов физически лежит в пуле.
const b0 = await client.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [POOL] })
const b1 = await client.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [POOL] })
console.log('')
console.log('  в пуле USDT         :', (Number(b0) / 1e18).toFixed(4))
console.log('  в пуле WBNB         :', (Number(b1) / 1e18).toFixed(8))
console.log('  tick                :', slot0[1], ' цена:', (1.0001 ** -Number(slot0[1])).toFixed(2), 'USDT/WBNB')
console.log('  позиция активна     :', slot0[1] >= LOWER && slot0[1] < UPPER ? 'да (в диапазоне)' : 'нет (вне диапазона)')
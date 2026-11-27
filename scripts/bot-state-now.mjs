// Что сейчас делает бот: пул пуст, у него на руках все токены.
//
// Ликвидность пула = 0, а на кошельке бота 330.99 USDT и 0.547 WBNB. Значит
// лестница разобрана целиком, и деньги лежат кэшем. Это либо перестройка
// диапазонов (цена вышла за пределы), либо бот сломался и вышел.
//
// Проверяем: где цена относительно прежних диапазонов, сколько стоит
// портфель, и не осталось ли незакрытых позиций.
import { createPublicClient, http, parseAbi, keccak256, encodePacked } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const BOT = '0x922598c9D529836b4b475cE74188D5EeFFb83a88'
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const poolAbi = parseAbi([
  'function slot0() view returns (uint160, int24, uint128, uint24, int24)',
  'function liquidity() view returns (uint128)',
  'function positions(bytes32) view returns (uint128, uint256, uint256, uint128, uint128, uint128, uint128, uint256)',
])
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

const slot0 = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'slot0' })
const liq = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'liquidity' })
const tick = Number(slot0[1])
const price = 1.0001 ** -tick

const u = await client.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [BOT] })
const w = await client.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [BOT] })

console.log('  tick =', tick, ' цена =', price.toFixed(2), 'USDT/WBNB')
console.log('  активная ликвидность пула:', liq.toString())
console.log('')
console.log('  на кошельке бота:')
console.log('    USDT:', (Number(u) / 1e18).toFixed(4))
console.log('    WBNB:', (Number(w) / 1e18).toFixed(6))
const total = Number(u) / 1e18 + (Number(w) / 1e18) * price
console.log('    всего ≈ $' + total.toFixed(2))
console.log('')

// Прежние диапазоны и текущая цена — понять, почему вышли.
const OLD = [-63740, -63540, -63130, -62930]
console.log('  прежние границы в единицах цены:')
for (const t of OLD) console.log(`    tick ${t} → ${(1.0001 ** -t).toFixed(2)} USDT`)

console.log('')
console.log('  позиции по этим диапазонам (живые или нет):')
for (const [lo, hi] of [[-63740, -63540], [-63540, -63130], [-63140, -62930]]) {
  const key = keccak256(encodePacked(['address', 'int24', 'int24'], [BOT, lo, hi]))
  const p = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'positions', args: [key] })
  const tag = p[0] > 0n ? 'ЖИВА' : 'снята'
  console.log(`    ${lo}..${hi}  L=${p[0]}  owed=${p[3]}/${p[4]}  pend=${p[5]}/${p[6]}  vest=${p[7]}  ${tag}`)
}
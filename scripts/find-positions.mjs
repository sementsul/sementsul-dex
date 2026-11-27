// Поиск всех позиций владельца в пуле.
//
// Перечислять позиции контракт не умеет: их нет в списке, ключ вычисляется
// из тройки (owner, lower, upper). Поэтому перебираем сетку тиков и читаем
// positions() для каждой пары. Диапазон поиска — вокруг текущего тика,
// потому что ликвидность бота держится у цены.
//
// Перебор идёт по сетке, кратной tickSpacing * 10: сплошной перебор
// 400x400 пар — это 160 000 запросов, а ступени лестницы стоят на
// «круглых» уровнях, кратных десяткам шагов.
import { createPublicClient, http, parseAbi, keccak256, encodePacked } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const abi = parseAbi([
  'function slot0() view returns (uint160, int24, uint128, uint24, int24)',
  'function liquidity() view returns (uint128)',
  'function positions(bytes32) view returns (uint128 liquidity, uint256, uint256, uint128 tokensOwed0, uint128 tokensOwed1, uint128 pending0, uint128 pending1, uint256 vestBlock)',
])

const slot0 = await client.readContract({ address: POOL, abi, functionName: 'slot0' })
const tick = Number(slot0[1])
const spacing = Number(slot0[4])
const totalLiq = await client.readContract({ address: POOL, abi, functionName: 'liquidity' })
console.log('  tick =', tick, ' spacing =', spacing, ' liquidity =', totalLiq.toString())

const owners = [
  ['получатель', '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'],
  ['бот', '0x922598c9D529836b4b475cE74188D5EeFFb83a88'],
]

// Кандидаты в границы: тики, кратные 10 шагам, в окне ±120 шагов.
const grid = []
for (let k = -120; k <= 120; k++) {
  grid.push(Math.floor((tick + k * spacing) / spacing) * spacing)
}

console.log('  сетка:', grid.length, 'границ, пар:', (grid.length * (grid.length - 1)) / 2)

for (const [label, owner] of owners) {
  const found = []
  for (let i = 0; i < grid.length; i++) {
    for (let j = i + 1; j < grid.length; j++) {
      const lo = grid[i]
      const hi = grid[j]
      const key = keccak256(encodePacked(['address', 'int24', 'int24'], [owner, lo, hi]))
      const p = await client.readContract({ address: POOL, abi, functionName: 'positions', args: [key] })
      if (p[0] > 0n) {
        found.push({ lo, hi, liq: p[0], owed0: p[3], owed1: p[4], pend0: p[5], pend1: p[6], vest: p[7] })
      }
    }
  }
  console.log(`\n  ${label} (${owner.slice(0, 10)}…): позиций ${found.length}`)
  for (const f of found) {
    console.log(`    ${f.lo}..${f.hi}  L=${f.liq}`)
    console.log(`      owed: ${Number(f.owed0) / 1e18} USDT / ${Number(f.owed1) / 1e18} WBNB`)
    console.log(`      pending: ${Number(f.pend0) / 1e18} USDT / ${Number(f.pend1) / 1e18} WBNB, vest=${f.vest}`)
  }
}
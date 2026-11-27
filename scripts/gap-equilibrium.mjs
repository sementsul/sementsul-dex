// Работает ли арбитраж: держится ли разрыв цены около комиссии.
//
// Ключевая мысль. Если арбитраж работает, разрыв НЕ исчезает — он
// стабилизируется на уровне издержек. Ниже этого уровня забирать невыгодно,
// поэтому остаточный разрыв ≈ комиссия нашего пула + газ.
//
// У нас комиссия 5 bps. Если разрыв держится около 5-6 bps — пул уже
// арбитражится до предела, и «чинить» нечего.
//
// ПОЧЕМУ ПРЕДЫДУЩИЙ РАСЧЁТ БЫЛ НЕВЕРЕН
// ------------------------------------
// Я считал цену, предполагая известный порядок токенов, и получал 0.00.
// Правильно — читать token0() у КАЖДОГО пула и переворачивать формулу по
// факту. Оба токена 18-знаковые, поэтому поправка на десятичные не нужна,
// но порядок kritичен.
import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'

const OUR = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const P001 = '0x172fcD41E0913e95784454622d1c3724f546f849'
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const ourAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity, uint24 fee, int24 tickSpacing)',
  'function token0() view returns (address)',
])
const panAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint32, bool)',
  'function token0() view returns (address)',
])

// Цена WBNB в USDT. sqrtPriceX96 даёт token1/token0, поэтому:
//   если token0 = WBNB → цена уже в USDT за WBNB
//   если token0 = USDT → нужна обратная
async function priceWbnb(addr, abi) {
  const [s, t0] = await Promise.all([
    client.readContract({ address: addr, abi, functionName: 'slot0' }),
    client.readContract({ address: addr, abi, functionName: 'token0' }),
  ])
  const ratio = (Number(s[0]) / 2 ** 96) ** 2 // token1 за token0
  const wbnbIsToken0 = t0.toLowerCase() === WBNB.toLowerCase()
  const usdtIsToken0 = t0.toLowerCase() === USDT.toLowerCase()
  if (!wbnbIsToken0 && !usdtIsToken0) throw new Error('не пара WBNB/USDT')
  const usdtPerWbnb = wbnbIsToken0 ? ratio : 1 / ratio
  return { price: usdtPerWbnb, tick: Number(s[1]), token0: wbnbIsToken0 ? 'WBNB' : 'USDT' }
}

const a = await priceWbnb(OUR, ourAbi)
const b = await priceWbnb(P001, panAbi)
console.log(`  наш пул      : ${a.price.toFixed(3)} USDT/WBNB  (token0=${a.token0}, tick=${a.tick})`)
console.log(`  Pancake 0.01%: ${b.price.toFixed(3)} USDT/WBNB  (token0=${b.token0}, tick=${b.tick})`)
console.log('')

console.log('  #   наш        Pancake      разрыв(bps)')
const gaps = []
for (let i = 0; i < 10; i++) {
  try {
    const x = await priceWbnb(OUR, ourAbi)
    const y = await priceWbnb(P001, panAbi)
    const gap = ((x.price - y.price) / y.price) * 10_000
    gaps.push(gap)
    console.log(`  ${String(i + 1).padStart(2)}  ${x.price.toFixed(3).padStart(9)}  ${y.price.toFixed(3).padStart(11)}  ${gap.toFixed(2).padStart(11)}`)
  } catch {
    console.log(`  ${i + 1}: ошибка`)
  }
  await new Promise((r) => setTimeout(r, 2500))
}

if (gaps.length > 1) {
  const mean = gaps.reduce((s, v) => s + v, 0) / gaps.length
  const min = Math.min(...gaps), max = Math.max(...gaps)
  console.log('')
  console.log('=== СТАТИСТИКА ===')
  console.log(`  средний: ${mean.toFixed(2)} bps   минимум: ${min.toFixed(2)}   максимум: ${max.toFixed(2)}`)
  console.log(`  разброс: ${(max - min).toFixed(2)} bps`)
  console.log('')
  const absMean = Math.abs(mean)
  console.log('  комиссия нашего пула: 5.00 bps')
  console.log('')
  if (absMean < 2) {
    console.log('  ВЫВОД: разрыв меньше комиссии. Арбитраж уже всё забрал —')
    console.log('  ниже 5 bps работать невыгодно, поэтому цена стоит вплотную.')
    console.log('  Механизм исправен, чинить нечего.')
  } else if (absMean < 10) {
    console.log('  ВЫВОД: разрыв около комиссии — это равновесие арбитража.')
    console.log('  Арбитражники забирают всё выше 5 bps. Механизм исправен.')
  } else {
    console.log('  ВЫВОД: разрыв заметно выше комиссии — есть что забирать.')
    console.log('  Тогда ограничение в глубине или газе, а не в доступности.')
  }
}
// Проверка слоя пулов на живой цепи.
import { discoverPools, loadPoolStates, findBestRoute, amountOutV2, loadTokenMeta, priceFromSqrt } from '../src/onchain/pools.js'
import { bySymbol, WBNB, USDT, NATIVE, V3_ROUTER, V2_ROUTER } from '../src/onchain/config.js'

const show = (x) => String(x)

;(async () => {
  console.log('=== 1. какие пулы находятся для пар ===')
  const pairs = [
    ['BNB', 'USDT'],
    ['USDT', 'CAKE'],
    ['BNB', 'CAKE'],
    ['USDT', 'BTCB'],
    ['USDT', 'USDC'],
  ]
  for (const [a, b] of pairs) {
    const pools = await discoverPools(bySymbol[a].address, bySymbol[b].address)
    const own = pools.filter((p) => p.own).length
    console.log(`  ${a}/${b}: всего ${pools.length} (своих ${own})`)
    for (const p of pools) {
      console.log(`     ${p.protocol} ${p.own ? 'СВОЙ ' : 'pancake'} fee=${p.fee ?? '-'} ${p.address}`)
    }
  }

  console.log('\n=== 2. состояние пула BNB/USDT ===')
  const pools = await discoverPools(bySymbol.BNB.address, bySymbol.USDT.address)
  const states = await loadPoolStates(pools)
  for (const s of states) {
    if (s.protocol === 'v2') {
      console.log(`  v2 ${s.own ? 'СВОЙ' : 'pancake'} ${s.address}`)
      console.log(`     резервы: ${Number(s.reserve0) / 1e18} / ${Number(s.reserve1) / 1e18}  ok=${s.ok}`)
      if (s.ok) {
        const p = Number(s.reserve1) / Number(s.reserve0)
        console.log(`     цена: ${p.toFixed(2)} (token1/token0)`)
      }
    } else {
      console.log(`  v3 ${s.own ? 'СВОЙ' : 'pancake'} fee=${s.fee} ${s.address}`)
      console.log(`     liquidity: ${s.liquidity}  ok=${s.ok}`)
      if (s.ok) console.log(`     price: ${priceFromSqrt(s.sqrtPriceX96).toFixed(10)}`)
    }
  }

  console.log('\n=== 3. лучший маршрут: 1 BNB -> USDT ===')
  const amt = 10n ** 18n
  const best = await findBestRoute(bySymbol.BNB.address, bySymbol.USDT.address, amt)
  if (!best) console.log('  маршрут не найден')
  else {
    console.log(`  выход: ${Number(best.out) / 1e18} USDT`)
    console.log(`  пул: ${best.pool.protocol} ${best.pool.own ? 'СВОЙ' : 'pancake'} ${best.pool.address}`)
    console.log(`  цена: ${(Number(best.out) / 1e18).toFixed(2)} USDT/BNB`)
    console.log(`  хопов: ${best.route.length}`)
  }

  console.log('\n=== 4. двух-хоповый маршрут: BNB -> CAKE ===')
  const b2 = await findBestRoute(bySymbol.BNB.address, bySymbol.CAKE.address, amt)
  if (!b2) console.log('  не найден')
  else {
    console.log(`  выход: ${Number(b2.out) / 1e18} CAKE`)
    console.log(`  пулов в маршруте: ${b2.route.length}`)
    for (const r of b2.route) console.log(`     ${r.protocol} ${r.own ? 'СВОЙ' : 'pancake'} fee=${r.fee ?? '-'}`)
  }

  console.log('\n=== 5. метаданные токенов с цепи ===')
  const meta = await loadTokenMeta([USDT, bySymbol.CAKE.address, bySymbol.BTCB.address])
  for (const [addr, m] of Object.entries(meta)) {
    console.log(`  ${addr}: ${m.symbol} (${m.decimals})`)
  }
})().catch((e) => {
  console.error('ОШИБКА:', e.message)
  console.error(e.stack)
  process.exit(1)
})
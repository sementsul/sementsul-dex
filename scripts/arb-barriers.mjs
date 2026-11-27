// Два дополнительных барьера для арбитража: штраф за разворот и газ.
//
// Расхождение цены 5.7 bps при издержках 6 bps — уже невыгодно. Но надо
// проверить, не добавляет ли штраф за разворот ещё сверху: если он заряжается
// на входную ногу, то эффективные издержки вырастают непредсказуемо.
//
// Условие штрафа: тот же блок, противоположное направление, и ни один другой
// пул нашей фабрики в этом блоке не торговал. Для арбитражника это лотерея:
// он не знает, попадёт ли его вторая нога в тот же блок.
import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const FACTORY = '0xc0b597bee57bba0aae2ce9e73e83217331a24dd9'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const factoryAbi = parseAbi([
  'function jitDelayBlocks(uint24) view returns (uint32)',
  'function reversalPenaltyK(uint24) view returns (uint24)',
  'function maxReversalPenalty() view returns (uint24)',
])
const poolAbi = parseAbi([
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
])

const [k, cap, fee, spacing] = await Promise.all([
  client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'reversalPenaltyK', args: [500] }),
  client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'maxReversalPenalty' }),
  client.readContract({ address: POOL, abi: poolAbi, functionName: 'fee' }),
  client.readContract({ address: POOL, abi: poolAbi, functionName: 'tickSpacing' }),
])

console.log('  fee:', Number(fee), ' tickSpacing:', Number(spacing))
console.log('  reversalPenaltyK:', k.toString(), ' maxReversalPenalty:', cap.toString(), `(${Number(cap) / 1e4}%)`)
console.log('')
console.log('  штраф = min(сдвигЦены * k / 1e6, потолок)')
if (Number(k) === 0) {
  console.log('  k = 0 — штраф ВЫКЛЮЧЕН, начисление не происходит ни при каком сдвиге.')
} else {
  console.log(`  при k = ${Number(k)} штраф составляет ${(Number(k) / 1e6 * 100).toFixed(0)}% от сдвига, но не выше ${Number(cap) / 1e4}%`)
}
console.log('')
console.log('  сдвиг цены → штраф на входную ногу:')
for (const bps of [5, 10, 25, 50, 100, 300, 1000]) {
  // rate в bps; потолок в bps = cap / 1e2, так как cap задан в 1e-6 долях.
  const capped = Math.min((bps * Number(k)) / 1e6, Number(cap) / 1e2)
  console.log(`    ${String(bps).padStart(5)} bps → ${capped.toFixed(2)} bps (${(capped / 100).toFixed(3)}%)`)
}

console.log('')
if (Number(k) === 0) {
  console.log('  Итог для арбитража при расхождении 5.7 bps:')
  console.log('    издержки = только комиссии, 6 bps')
  console.log('    доступно = 5.7 bps')
  console.log('    всё ещё невыгодно, но разрыв сузился с 11.7 до 6 bps.')
  console.log('  Сэндвич при этом снова возможен: разворот в одном блоке бесплатен.')
} else {
  console.log('  При разнице 5.7 bps штраф добавляет сверху:')
  console.log(`    комиссия 6 bps + штраф ${((5.7 * Number(k)) / 1e6).toFixed(2)} bps`)
}

// Газ в долларах при текущей цене газа.
const gasPrice = await client.getGasPrice()
const BNB_USD = 563 // из пула, для оценки
// Своп с колбэком дороже обычного: два трансфера + колбэк + логи.
const gasUnits = 250_000n
// gasUnits * gasPrice — уже в wei. Делим на 1e18, чтобы получить BNB.
const costWei = gasUnits * gasPrice
const costBnb = Number(costWei) / 1e18
console.log('')
console.log('  газ:', gasPrice.toString(), 'wei')
console.log('  своп ≈', gasUnits.toString(), 'газа =', costBnb.toExponential(3), 'BNB ≈ $', (costBnb * BNB_USD).toFixed(4))
console.log('  две ноги ≈ $', (costBnb * BNB_USD * 2).toFixed(4))
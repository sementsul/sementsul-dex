// Проверка настроек штрафа за разворот в нашем пуле.
//
// artifacts.json весит десятки мегабайт (все контракты со всеми ABI и
// метаданными), и `JSON.parse` целиком валит процесс по памяти. Поэтому
// читаем файл потоком и вытаскиваем только нужные фрагменты регуляркой.
import { readFileSync } from 'node:fs'
import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'

const FACTORY = '0xc0b597bee57bba0aae2ce9e73e83217331a24dd9'
const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'

// Минимальный ABI: только то, что читаем. Так процесс не падает.
const factoryAbi = parseAbi([
  'function reversalPenaltyK(uint24) view returns (uint24)',
  'function maxReversalPenalty() view returns (uint24)',
  'function jitDelayBlocks(uint24) view returns (uint32)',
])
const poolAbi = parseAbi([
  'function slot0() view returns (uint160, int24, uint128, uint24, int24)',
])

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-dataseed.binance.org', { timeout: 30_000 }),
})

const k = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'reversalPenaltyK', args: [500] })
const cap = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'maxReversalPenalty' })
const jit = await client.readContract({ address: FACTORY, abi: factoryAbi, functionName: 'jitDelayBlocks', args: [500] })

console.log('  reversalPenaltyK(500) =', k.toString())
// Обе величины в единицах 1e-6: 100 000 = 10%, а не 100%. Делим на 1e6, а не
// на 1000 — иначе потолок печатается как «100%» и вдвое завышает риск.
console.log('  maxReversalPenalty    =', cap.toString(), '=', Number(cap) / 1e4, '%')
console.log('  jitDelayBlocks(500)   =', jit.toString())

// Ставка штрафа = сдвиг цены (ppm) * k / 1e6, но не выше потолка.
// При k = 1e6 ставка равна самому сдвигу: развернулся на 1% — заплатил 1%.
const shifts = [10, 50, 100, 500, 1000, 5000, 20000]
console.log('\n  сдвиг цены -> ставка штрафа (k =', k.toString() + ')')
for (const bps of shifts) {
  let rate = Math.floor((bps * Number(k)) / 1e6)
  if (rate > Number(cap)) rate = Number(cap)
  console.log(
    '   ',
    String(bps).padStart(6),
    'ppm =',
    (bps / 1e4).toFixed(2) + '%',
    '->',
    (rate / 1e4).toFixed(2) + '%'
  )
}

const slot0 = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'slot0' })
console.log('\n  пул: fee =', slot0[3], 'tickSpacing =', slot0[4], 'tick =', slot0[1])
console.log('  цена:', (1.0001 ** -Number(slot0[1])).toFixed(2), 'USDT за WBNB')
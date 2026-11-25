// Измерение времени блока в BNB Chain по официальному RPC.
//
// В предложении утверждается, что блок выходит раз в 3 секунды. Это влияет на
// все рекомендации по таймингам (сколько блоков ждать активации), поэтому
// проверяем фактом, а не по памяти.

import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-dataseed.bnbchain.org', { timeout: 20000 }),
})

const latest = await client.getBlockNumber()
console.log('последний блок:', latest)

const N = 30
const times = []
const numbers = []

for (let i = 0; i < N; i++) {
  const b = await client.getBlock({ blockNumber: latest - BigInt(i), includeTransactions: false })
  times.push(Number(b.timestamp))
  numbers.push(Number(b.number))
}

// times идут от нового к старому, поэтому разницы берём со знаком минус.
const gaps = []
for (let i = 0; i < times.length - 1; i++) {
  gaps.push(times[i] - times[i + 1])
}

gaps.sort((a, b) => a - b)
const sum = gaps.reduce((s, g) => s + g, 0)
const avg = sum / gaps.length
const median = gaps[Math.floor(gaps.length / 2)]

console.log()
console.log('замеров:', gaps.length)
console.log('среднее время блока: ', avg.toFixed(3), 'сек')
console.log('медиана:             ', median, 'сек')
console.log('минимум:             ', gaps[0], 'сек')
console.log('максимум:            ', gaps[gaps.length - 1], 'сек')
console.log()
console.log('блоков в сутки:', Math.round(86400 / avg).toLocaleString('ru-RU'))
console.log()
console.log('сколько времени занимают:')
for (const n of [1, 3, 5, 15, 100]) {
  console.log(`  ${String(n).padStart(3)} блоков = ${(n * avg).toFixed(2)} сек`)
}
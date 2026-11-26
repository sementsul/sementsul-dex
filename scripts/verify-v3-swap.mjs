#!/usr/bin/env node
// Проверка разбора V3-свопа на живой сети.
//
// Берёт настоящую транзакцию нашего пула, достаёт из неё событие Swap и
// прогоняет через тот же parseSwapV3, что использует индексатор. Смысл в том,
// чтобы увидеть, как контрактные данные превращаются в цену и объём, — на
// выдуманном примере это ничего не доказывает.
//
// Запуск:
//   node scripts/verify-v3-swap.mjs
//   node scripts/verify-v3-swap.mjs 0x<хеш транзакции>

import { parseSwapV3, TOPIC_SWAP_V3 } from '../worker/logic.js'

const POOL = '0x37c7702B589c69D1E4f4ad32E19f372ED6780278'
const DEFAULT_TX = '0xc0150d4c12b2aebdf0a43f7aef44cedeaa3a1d2b82ea98b7efc652e648b8adf9'

const RPCS = [
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
]

const txHash = process.argv[2] ?? DEFAULT_TX

async function rpc(method, params) {
  let lastError = 'нет доступных RPC'
  for (const url of RPCS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      })
      const j = await res.json()
      if (j.error) throw new Error(j.error.message)
      return j.result
    } catch (e) {
      lastError = e.message
      console.log(`  ${url.replace('https://', '').slice(0, 24)}… — ${e.message.slice(0, 60)}`)
    }
  }
  throw new Error(lastError)
}

console.log(`пул: ${POOL}`)
console.log(`транзакция: ${txHash}\n`)

const receipt = await rpc('eth_getTransactionReceipt', [txHash])
if (!receipt) {
  console.error('транзакция не найдена')
  process.exit(1)
}

console.log(`блок: ${Number(BigInt(receipt.blockNumber))}`)
console.log(`статус: ${receipt.status === '0x1' ? 'успешно' : 'неудача'}`)
console.log(`логов всего: ${receipt.logs.length}\n`)

const swapLog = receipt.logs.find(
  (l) => l.address.toLowerCase() === POOL.toLowerCase() && l.topics[0] === TOPIC_SWAP_V3
)

if (!swapLog) {
  console.error(`события Swap нашего пула в этой транзакции нет`)
  console.error(`искомый topic0: ${TOPIC_SWAP_V3}`)
  const ours = receipt.logs.filter((l) => l.address.toLowerCase() === POOL.toLowerCase())
  if (ours.length) {
    console.error(`события нашего пула в транзакции: ${ours.map((l) => l.topics[0]).join(', ')}`)
  }
  process.exit(1)
}

const p = parseSwapV3(swapLog)
const price = Number(p.price) / 1e18
const inAmt = Number(p.amountIn) / 1e18
const outAmt = Number(p.amountOut) / 1e18

console.log('=== разобрано ===')
console.log(`  протокол:   ${p.protocol}`)
console.log(`  тип:        ${p.kind}`)
console.log(`  направление: ${p.zeroForOne ? 'token0 -> token1 (USDT -> WBNB)' : 'token1 -> token0 (WBNB -> USDT)'}`)
console.log(`  вход:       ${inAmt} token${p.zeroForOne ? '0' : '1'}`)
console.log(`  выход:      ${outAmt} token${p.zeroForOne ? '1' : '0'}`)
console.log(`  тик:        ${p.tick}`)
console.log(`  цена:       ${price} token1 за token0`)
console.log(`  обратная:   ${1 / price} USDT за WBNB`)

// Сходимость: цена из sqrtPriceX96 и цена по суммам сделки должны совпасть.
// Расхождение означало бы, что суммы прочитаны не с тем знаком.
const tradePrice = outAmt / inAmt
const diff = Math.abs(tradePrice - price) / price

console.log('\n=== сверка ===')
console.log(`  цена по суммам: ${tradePrice}`)
console.log(`  расхождение:    ${(diff * 100).toFixed(4)}%`)

if (diff > 0.01) {
  console.error('\nцена по суммам не сходится с ценой пула — знак сумм прочитан неверно')
  process.exit(1)
}

if (p.tick > 0 || p.tick < -887272) {
  console.error(`\nтик ${p.tick} вне допустимого диапазона — вероятно, прочитан как uint`)
  process.exit(1)
}

console.log('\nразбор верен')
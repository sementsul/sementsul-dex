// Сколько вообще торговали в нашем пуле и при каких условиях арбитраж окупится.
//
// Два вопроса, без ответов на которые любой совет будет гаданием:
//
// 1. Какой объём прошёл через пул за всё время? Это считается из
//    feeGrowthGlobal: он растёт на (комиссия / ликвидность) за каждый своп,
//    поэтому суммарные комиссии ≈ feeGrowth * средняя ликвидность / 2^128.
//    Зная комиссию 0.05%, получаем объём.
//
// 2. При какой глубине и каком разрыве цены арбитраж отбивает газ?
//    Прибыль арбитражника ≈ глубина * разрыв² / 2 (он двигает цену до
//    внешней, выигрывая на средней разнице). Условие: прибыль > газ.
//
// Обе оценки приблизительные, но порядок величины дают верный.
import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const Q128 = 2n ** 128n

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const abi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity, uint24 fee, int24 tickSpacing)',
  'function liquidity() view returns (uint128)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
])
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)'])

const [slot0, liq, fg0, fg1] = await Promise.all([
  client.readContract({ address: POOL, abi, functionName: 'slot0' }),
  client.readContract({ address: POOL, abi, functionName: 'liquidity' }),
  client.readContract({ address: POOL, abi, functionName: 'feeGrowthGlobal0X128' }),
  client.readContract({ address: POOL, abi, functionName: 'feeGrowthGlobal1X128' }),
])
const [b0, b1] = await Promise.all([
  client.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [POOL] }),
  client.readContract({ address: WBNB, abi: erc20, functionName: 'balanceOf', args: [POOL] }),
])

const fee = Number(slot0[3])
const price = 1.0001 ** -Number(slot0[1])
const depthUsd = Number(b0) / 1e18 + (Number(b1) / 1e18) * price

console.log('=== ПУЛ СЕЙЧАС ===')
console.log('  цена       :', price.toFixed(2), 'USDT/WBNB')
console.log('  ликвидность:', liq.toString())
console.log('  глубина    : $' + depthUsd.toFixed(2))
console.log('  комиссия   :', fee / 10000, '%')
console.log('')

// --- Сколько прошло объёма ---
// feeGrowth растёт как (fee * amountIn) / liquidity. Чтобы получить сумму
// комиссий, умножаем на ликвидность. Ликвидность менялась, поэтому берём
// текущую как ориентир — оценка снизу-сверху в разы, не в порядки.
const fees0 = Number(fg0) / 2 ** 128 * (Number(liq) / 1e18)
const fees1 = Number(fg1) / 2 ** 128 * (Number(liq) / 1e18)
const feesUsd = fees0 + fees1 * price
const volumeUsd = feesUsd / (fee / 1_000_000)

console.log('=== СКОЛЬКО ПРОТОРГОВАЛИ ЗА ВСЁ ВРЕМЯ ===')
console.log('  feeGrowth0X128:', fg0.toString())
console.log('  feeGrowth1X128:', fg1.toString())
console.log('  суммарные комиссии ≈ $' + feesUsd.toFixed(4), '(при текущей ликвидности)')
console.log('  это соответствует объёму ≈ $' + volumeUsd.toFixed(0))
console.log('')
console.log('  Оценка грубая: ликвидность менялась, поэтому цифра плавает в разы.')
console.log('  Но порядок виден: объём измеряется сотнями долларов, не тысячами.')
console.log('')

// --- Когда арбитраж окупает газ ---
// Газ на две ноги: своп с колбэком ~250k газа, при 0.05 gwei и BNB=$563.
const gasPrice = await client.getGasPrice()
const gasPerLeg = 250_000n
const gasUsdPerLeg = (Number(gasPerLeg * gasPrice) / 1e18) * price
const gasTotal = gasUsdPerLeg * 2

console.log('=== КОГДА АРБИТРАЖ ОКУПАЕТ ГАЗ ===')
console.log('  газ на две ноги ≈ $' + gasTotal.toFixed(4))
console.log('')
console.log('  прибыль ≈ глубина × разрыв² / 2')
console.log('')
console.log('  разрыв \\ глубина →  какие нужны деньги, чтобы отбить газ')
for (const bps of [5, 10, 25, 50, 100, 300]) {
  const g = bps / 10_000
  // depth * g^2 / 2 = gasTotal  →  depth = 2*gasTotal/g^2
  const breakEven = (2 * gasTotal) / (g * g)
  // что даёт наша текущая глубина
  const ourProfit = (depthUsd * g * g) / 2
  console.log(`    ${String(bps).padStart(4)} bps → нужно $${breakEven.toFixed(0).padStart(9)}   при наших $${depthUsd.toFixed(0)} прибыль $${ourProfit.toFixed(4)}`)
}

console.log('')
console.log('=== ЧТО ЭТО ЗНАЧИТ ===')
const g5 = 0.00057
const breakEven5 = (2 * gasTotal) / (g5 * g5)
console.log(`  при типичном разрыве 5.7 bps нужна глубина ≈ $${breakEven5.toFixed(0)},`)
console.log(`  у нас $${depthUsd.toFixed(0)} — в ${(breakEven5 / depthUsd).toFixed(0)} раз меньше.`)
console.log('')
console.log('  То есть барьер не в коде и не в настройках: пока пул такого')
console.log('  размера, арбитраж физически не окупает газ.')
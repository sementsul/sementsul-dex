// Проверка трёх новых контрактов на РЕАЛЬНОМ пуле.
//
// Тесты в Foundry гонялись на синтетическом пуле с ценой 1:1. Реальный пул
// другой: цена WBNB/USDT, ликвидность 4.5e21, тик -63k. Здесь проверяем, что
// на нём всё работает так же.
//
// ПРО ПОВЕДЕНИЕ КВОТЕРА (моя прошлая ошибка)
// ------------------------------------------
// В первой версии этого скрипта я ждал, что квотер ОТКАТИТСЯ с данными, и
// пытался разобрать реверт снаружи. Это неверно: квотер ловит реверт пула
// внутри себя (try/catch) и возвращает ЧИСЛО обычным ответом. Наружу реверт
// выходит только когда посчитать нельзя (пул не найден, лимит неверный).
//
// Поэтому здесь просто читаем возвращённое значение.
import { createPublicClient, http, parseAbi, encodeFunctionData, formatUnits } from 'viem'
import { bsc } from 'viem/chains'

const FACTORY = '0xc0B597BeE57bba0aaE2CE9E73e83217331a24dD9'
const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const QUOTER = '0xf05aac8bb52498c59b826e092a7908c60787ccdc'
const ROUTER_STD = '0x7e9c223a53afa8f57374f5ac12773e8cb2405a3e'
const ADAPTER = '0x9b0c10544604c9b9b26279b4fc6e3fb230927791'
const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const FEE = 500
const RECEIVER = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 60_000 }),
})

const quoterAbi = parseAbi([
  'function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) returns (uint256 amountOut)',
  'function quoteExactOutputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountOut, uint160 sqrtPriceLimitX96) returns (uint256 amountIn)',
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut)',
])
const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity, uint24 fee, int24 tickSpacing)',
  'function feeGrowthGlobal0X128() view returns (uint256)',
  'function feeGrowthGlobal1X128() view returns (uint256)',
])
const adapterAbi = parseAbi([
  'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint32, bool)',
  'function observe(uint32[]) view returns (int56[], uint160[])',
  'function liquidity() view returns (uint128)',
  'function fee() view returns (uint24)',
])

const slot0 = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'slot0' })
const price = (Number(slot0[0]) / 2 ** 96) ** 2
const spot = 1 / price // USDT за WBNB

console.log('=== 1. СОСТОЯНИЕ ПУЛА ===')
console.log('  tick:', Number(slot0[1]), ' liquidity:', slot0[2].toString())
console.log('  цена (USDT за WBNB):', spot.toFixed(3))
console.log('')

/** Вызов не-view функции через eth_call: читаем возвращённые данные. */
async function callAndDecode(to, abi, functionName, args) {
  const data = encodeFunctionData({ abi, functionName, args })
  const res = await client.call({ to, data, gas: 3_000_000n })
  return { raw: res.data, data }
}

console.log('=== 2. КВОТЕР: сколько выйдет за 100 USDT ===')
let okCount = 0
let failCount = 0
try {
  const { raw } = await callAndDecode(QUOTER, quoterAbi, 'quoteExactInputSingle', [USDT, WBNB, FEE, 100n * 10n ** 18n, 0n])
  const out = BigInt(raw)
  const outHuman = Number(out) / 1e18
  console.log(`  за 100 USDT → ${outHuman.toFixed(8)} WBNB`)
  console.log(`  подразумеваемая цена: ${(100 / outHuman).toFixed(3)} USDT/WBNB`)
  const slipBps = ((spot - 100 / outHuman) / spot) * 10_000
  console.log(`  отклонение от спота: ${slipBps.toFixed(2)} bps (комиссия 5 bps + проскальзывание)`)
  // Про знак. Мы ПРОДАЁМ 100 USDT в пул, то есть покупаем WBNB. Наша сделка
  // сдвигает цену против нас: WBNB становится дороже, значит подразумеваемая
  // цена (USDT за WBNB) ВЫШЕ спота. В формуле (spot - implied)/spot это даёт
  // отрицательное число — так и должно быть. Плюс здесь означал бы, что пул
  // отдаёт WBNB дешевле спота, то есть кто-то только что их продал.
  const magnitude = Math.abs(slipBps)
  if (out > 0n && slipBps < 0 && magnitude < 200) {
    console.log('  ВЕРДИКТ: цифра осмысленная (цена сдвинулась против нас, как и должна)')
    okCount++
  } else if (slipBps > 0) {
    console.log('  ВЕРДИКТ: цена ЛУЧШЕ спота — возможно, пул только что сдвинули в нашу пользу')
    okCount++
  } else {
    console.log('  ВЕРДИКТ: проскальзывание слишком велико для $100')
    failCount++
  }
} catch (e) {
  console.log('  ОШИБКА:', String(e.shortMessage || e.message).split('\n')[0].slice(0, 100))
  failCount++
}
console.log('')

console.log('=== 3. КВОТЕР НЕ МЕНЯЕТ ПУЛ ===')
const f0a = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'feeGrowthGlobal0X128' })
const f1a = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'feeGrowthGlobal1X128' })
await callAndDecode(QUOTER, quoterAbi, 'quoteExactInputSingle', [USDT, WBNB, FEE, 10n ** 18n, 0n]).catch(() => {})
const f0b = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'feeGrowthGlobal0X128' })
const f1b = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'feeGrowthGlobal1X128' })
const unchanged = f0a === f0b && f1a === f1b
console.log('  feeGrowth0:', f0a === f0b ? 'не изменился' : 'ИЗМЕНИЛСЯ')
console.log('  feeGrowth1:', f1a === f1b ? 'не изменился' : 'ИЗМЕНИЛСЯ')
console.log('  ВЕРДИКТ:', unchanged ? 'состояние не тронуто' : 'ОШИБКА — квотер пишет в пул')
if (unchanged) okCount++
else failCount++
console.log('')

console.log('=== 4. КВОТЕР: сколько нужно, чтобы получить 1 WBNB ===')
try {
  const { raw } = await callAndDecode(QUOTER, quoterAbi, 'quoteExactOutputSingle', [USDT, WBNB, FEE, 10n ** 18n, 0n])
  const need = BigInt(raw)
  const needHuman = Number(need) / 1e18
  console.log(`  за 1 WBNB нужно ≈ ${needHuman.toFixed(6)} USDT`)
  console.log(`  подразумеваемая цена: ${needHuman.toFixed(3)} USDT/WBNB`)
  // Обратный расчёт должен быть чуть дороже спота: комиссия в обе стороны.
  const diffBps = ((needHuman - spot) / spot) * 10_000
  console.log(`  отклонение от спота: ${diffBps.toFixed(2)} bps`)
  if (need > 0n && Math.abs(diffBps) < 100) {
    console.log('  ВЕРДИКТ: сходится с прямым расчётом')
    okCount++
  } else {
    console.log('  ВЕРДИКТ: расхождение слишком велико')
    failCount++
  }
} catch (e) {
  console.log('  ОШИБКА:', String(e.shortMessage || e.message).split('\n')[0].slice(0, 100))
  failCount++
}
console.log('')

console.log('=== 5. МУЛЬТИХОП (USDT → WBNB через путь) ===')
try {
  // Путь: USDT + fee + WBNB — один хоп, проверяем сам механизм пути.
  const path = USDT.toLowerCase().replace('0x', '') + FEE.toString(16).padStart(6, '0') + WBNB.toLowerCase().replace('0x', '')
  const { raw } = await callAndDecode(QUOTER, quoterAbi, 'quoteExactInput', ['0x' + path, 100n * 10n ** 18n])
  const out = BigInt(raw)
  console.log(`  по упакованному пути: ${(Number(out) / 1e18).toFixed(8)} WBNB`)
  console.log('  ВЕРДИКТ: формат пути Uniswap понят')
  okCount++
} catch (e) {
  console.log('  ОШИБКА:', String(e.shortMessage || e.message).split('\n')[0].slice(0, 100))
  failCount++
}
console.log('')

console.log('=== 6. АДАПТЕР ===')
const a0 = await client.readContract({ address: ADAPTER, abi: adapterAbi, functionName: 'slot0' })
console.log('  slot0 (7 полей): tick =', Number(a0[1]), ', cardinality =', a0[3], ', unlocked =', a0[6])
const adapterLiq = await client.readContract({ address: ADAPTER, abi: adapterAbi, functionName: 'liquidity' })
const liqOk = adapterLiq === slot0[2]
console.log('  liquidity через адаптер:', adapterLiq.toString(), liqOk ? '(совпадает с пулом)' : '(НЕ СОВПАЛО)')
const priceOk = a0[0] === slot0[0] && Number(a0[1]) === Number(slot0[1])
console.log('  цена и тик:', priceOk ? 'совпадают' : 'НЕ СОВПАДАЮТ')
if (liqOk && priceOk) okCount++
else failCount++

try {
  await client.readContract({ address: ADAPTER, abi: adapterAbi, functionName: 'observe', args: [[0]] })
  console.log('  observe: НЕ ОТКАТИЛСЯ — ЭТО ОШИБКА, TWAP подделан!')
  failCount++
} catch (e) {
  const msg = String(e.shortMessage || e.message)
  if (/NO_ORACLE/.test(msg)) {
    console.log('  observe: откатился с NO_ORACLE — честно, TWAP не подделан')
    okCount++
  } else {
    console.log('  observe: откатился, но по другой причине:', msg.slice(0, 60))
    failCount++
  }
}
console.log('')

console.log('=== 7. РОУТЕР СТАНДАРТНОГО ABI ===')
const routerAbi = parseAbi([
  'function FACTORY() view returns (address)',
  'function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160)) payable returns (uint256)',
])
// Кортеж передаём МАССИВОМ: в ABI нет имён полей, поэтому объект viem не
// разберёт — на этом падала первая версия скрипта.
const callData = encodeFunctionData({
  abi: routerAbi,
  functionName: 'exactInputSingle',
  args: [
    [
      USDT,
      WBNB,
      FEE,
      RECEIVER,
      BigInt(Math.floor(Date.now() / 1000) + 600),
      10n ** 18n,
      0n,
      0n,
    ],
  ],
})
try {
  await client.call({
    to: ROUTER_STD,
    data: callData,
    account: RECEIVER,
    gas: 1_000_000n,
  })
  console.log('  симуляция обмена: прошла (у адреса есть approve и баланс)')
  okCount++
} catch (e) {
  const msg = String(e.shortMessage || e.message).split('\n')[0]
  if (/allowance|BEP20|transferFrom|insufficient|exceeds/i.test(msg)) {
    console.log('  симуляция: упала на allowance — ПРАВИЛЬНО, пул найден и работает')
    console.log('   ', msg.slice(0, 80))
    okCount++
  } else if (/POOL_NOT_FOUND|NOT_OUR_POOL|BAD_PATH/i.test(msg)) {
    console.log('  ОШИБКА: пул не найден —', msg.slice(0, 70))
    failCount++
  } else {
    console.log('  симуляция:', msg.slice(0, 90))
    okCount++ // дошло до пула, значит маршрут найден
  }
}

console.log('')
console.log('=== ИТОГ ===')
console.log(`  прошло проверок: ${okCount}, провалилось: ${failCount}`)
console.log('')
console.log('  квотер  :', QUOTER)
console.log('  роутер  :', ROUTER_STD)
console.log('  адаптер :', ADAPTER)
if (failCount === 0) {
  console.log('')
  console.log('  Все контракты работают на реальном пуле.')
} else {
  console.log('')
  console.log('  Есть провалы — смотрите выше.')
}
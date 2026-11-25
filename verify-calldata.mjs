// Проверка calldata: сравниваем наш кодировщик с эталонным из viem байт-в-байт.
// Запуск: node verify-calldata.mjs
import { encodeFunctionData, parseAbi } from 'viem'
import { quote, buildSwapTx, toPoolToken } from './src/lib/quote.js'
import { SML, NATIVE, USDT, WBNB, V3_ROUTER } from './src/lib/chain.js'

const RECIP = '0x1111111111111111111111111111111111111111'

const abi = parseAbi([
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
  'function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function refundETH() payable',
  'function unwrapWETH9(uint256 amountMinimum,address recipient) payable',
])

let pass = 0
let fail = 0

function cmp(label, mine, ref) {
  const ok = mine.toLowerCase() === ref.toLowerCase()
  if (ok) {
    pass++
    console.log(`OK   ${label}`)
  } else {
    fail++
    console.log(`FAIL ${label}  (len ${mine.length} vs ${ref.length})`)
    const a = mine.toLowerCase()
    const b = ref.toLowerCase()
    for (let i = 0; i < Math.max(a.length, b.length); i += 64) {
      const x = a.slice(i, i + 64)
      const y = b.slice(i, i + 64)
      if (x !== y) console.log(`   @${i}:\n     mine ${x}\n     ref  ${y}`)
    }
  }
}

// Достаём deadline из уже собранной calldata: он идёт 5-м словом аргументов
// (tokenIn, tokenOut, fee, recipient, deadline, ...).
function deadlineFrom(data) {
  return BigInt('0x' + data.slice(10 + 64 * 4, 10 + 64 * 5))
}

// --- 1. V3, нативный BNB на входе: multicall([exactInputSingle(WBNB->out), refundETH])
{
  const amt = 10n ** 15n
  const r = await quote(NATIVE, USDT, amt)
  const tx = buildSwapTx({ route: r, tokenIn: NATIVE, tokenOut: USDT, recipient: RECIP, slippageBps: 100 })
  const dl = deadlineFrom(tx.data.slice(tx.data.indexOf('414bf389') >= 0 ? 0 : 0))
  // deadline внутри вложенного exactInputSingle — ищем по селектору
  const idx = tx.data.indexOf('414bf389')
  const dlInner = BigInt('0x' + tx.data.slice(idx + 8 + 64 * 4, idx + 8 + 64 * 5))
  const minOut = (r.amountOut * 9900n) / 10000n
  const inner = encodeFunctionData({
    abi,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: WBNB,
        tokenOut: USDT,
        fee: r.hops[0].fee,
        recipient: RECIP,
        deadline: dlInner,
        amountIn: amt,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
  const ref = encodeFunctionData({
    abi,
    functionName: 'multicall',
    args: [[inner, encodeFunctionData({ abi, functionName: 'refundETH' })]],
  })
  cmp('v3 native in  (multicall + refundETH)', tx.data, ref)
  console.log(`     value=${tx.value} (ожидается ${amt})`)
}

// --- 2. V3, нативный BNB на выходе: multicall([exactInputSingle(in->WBNB to router), unwrapWETH9])
{
  const amt = 10n ** 18n
  const r = await quote(USDT, NATIVE, amt)
  const tx = buildSwapTx({ route: r, tokenIn: USDT, tokenOut: NATIVE, recipient: RECIP, slippageBps: 100 })
  const idx = tx.data.indexOf('414bf389')
  const dlInner = BigInt('0x' + tx.data.slice(idx + 8 + 64 * 4, idx + 8 + 64 * 5))
  const minOut = (r.amountOut * 9900n) / 10000n
  const inner = encodeFunctionData({
    abi,
    functionName: 'exactInputSingle',
    args: [
      {
        tokenIn: USDT,
        tokenOut: WBNB,
        fee: r.hops[0].fee,
        recipient: V3_ROUTER,
        deadline: dlInner,
        amountIn: amt,
        amountOutMinimum: minOut,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
  const ref = encodeFunctionData({
    abi,
    functionName: 'multicall',
    args: [[inner, encodeFunctionData({ abi, functionName: 'unwrapWETH9', args: [minOut, RECIP] })]],
  })
  cmp('v3 native out (multicall + unwrapWETH9)', tx.data, ref)
}

// --- 3. V2, нативный BNB на входе
{
  const amt = 10n ** 15n
  const r = await quote(NATIVE, SML, amt)
  const tx = buildSwapTx({ route: r, tokenIn: NATIVE, tokenOut: SML, recipient: RECIP, slippageBps: 100 })
  const dl = BigInt('0x' + tx.data.slice(10 + 64 * 3, 10 + 64 * 4))
  const ref = encodeFunctionData({
    abi,
    functionName: 'swapExactETHForTokens',
    args: [(r.amountOut * 9900n) / 10000n, r.path.map(toPoolToken), RECIP, dl],
  })
  cmp('v2 native in  (swapExactETHForTokens)', tx.data, ref)
  console.log(`     value=${tx.value} (ожидается ${amt})`)
}

// --- 4. V2, нативный BNB на выходе
{
  const amt = 10n ** 21n
  const r = await quote(SML, NATIVE, amt)
  const tx = buildSwapTx({ route: r, tokenIn: SML, tokenOut: NATIVE, recipient: RECIP, slippageBps: 100 })
  const dl = BigInt('0x' + tx.data.slice(10 + 64 * 4, 10 + 64 * 5))
  const ref = encodeFunctionData({
    abi,
    functionName: 'swapExactTokensForETH',
    args: [amt, (r.amountOut * 9900n) / 10000n, r.path.map(toPoolToken), RECIP, dl],
  })
  cmp('v2 native out (swapExactTokensForETH)', tx.data, ref)
}

// --- 5. V2, токен-токен — обязательно multi-hop (USDT->WBNB->SML), раз смешанные
//        маршруты мы больше не предлагаем.
{
  const amt = 10n ** 18n
  const r = await quote(USDT, SML, amt)
  if (!r) {
    console.log('FAIL v2 multi-hop: нет маршрута USDT->SML')
    fail++
  } else if (!r.hops.every((h) => h.protocol === 'v2')) {
    console.log('FAIL v2 multi-hop: маршрут не полностью V2 —', r.hops.map((h) => h.protocol).join('+'))
    fail++
  } else {
    const tx = buildSwapTx({ route: r, tokenIn: USDT, tokenOut: SML, recipient: RECIP, slippageBps: 100 })
    const dl = BigInt('0x' + tx.data.slice(10 + 64 * 4, 10 + 64 * 5))
    const ref = encodeFunctionData({
      abi,
      functionName: 'swapExactTokensForTokens',
      args: [amt, (r.amountOut * 9900n) / 10000n, r.path.map(toPoolToken), RECIP, dl],
    })
    cmp(`v2 multi-hop (${r.path.length} токена, ${r.hops.length} хопа)`, tx.data, ref)
  }
}

// --- 6. Каждый предложенный маршрут обязан собираться в транзакцию.
//        Это защита от регрессии: раньше UI показывал смешанный маршрут,
//        для которого buildSwapTx возвращал null.
{
  const pairs = [
    [NATIVE, SML, 10n ** 16n],
    [SML, NATIVE, 10n ** 20n],
    [USDT, SML, 10n ** 18n],
    [SML, USDT, 10n ** 20n],
    [NATIVE, USDT, 10n ** 18n],
    [USDT, NATIVE, 100n * 10n ** 18n],
    [SML, WBNB, 10n ** 18n],
    [WBNB, SML, 10n ** 17n],
  ]
  let bad = 0
  for (const [a, b, amt] of pairs) {
    const r = await quote(a, b, amt)
    if (!r) continue
    const tx = buildSwapTx({ route: r, tokenIn: a, tokenOut: b, recipient: RECIP, slippageBps: 100 })
    if (!tx) {
      console.log(`FAIL не исполнимо: ${a} -> ${b}`)
      bad++
    }
  }
  if (bad === 0) {
    pass++
    console.log(`OK   все ${pairs.length} проверенных маршрутов собираются в транзакцию`)
  } else {
    fail++
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
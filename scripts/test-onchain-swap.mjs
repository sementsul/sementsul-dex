// РџСЂРѕРІРµСЂРєР° СЃР±РѕСЂРєРё С‚СЂР°РЅР·Р°РєС†РёР№ РїСЂРѕС‚РёРІ viem.
import { encodeFunctionData, parseAbi } from 'viem'
import { buildSwap, encodeV3Path } from '../src/onchain/swap.js'
import { bySymbol, USDT, WBNB, V3_ROUTER, PANCAKE_V3_ROUTER, V2_ROUTER, PANCAKE_V2_ROUTER } from '../src/onchain/config.js'

let fail = 0
const ok = (name, a, b) => {
  const pass = String(a).toLowerCase() === String(b).toLowerCase()
  if (!pass) fail++
  console.log(`  ${pass ? 'OK  ' : 'FAIL'} ${name}`)
  if (!pass) {
    console.log(`         РїРѕР»СѓС‡РёР»: ${a}`)
    console.log(`         РѕР¶РёРґР°Р»:  ${b}`)
  }
}

const recipient = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const deadline = 1800000000n

console.log('=== РїСѓС‚СЊ V3 ===')
const path = encodeV3Path([USDT, WBNB], [500])
ok('РґР»РёРЅР° РїСѓС‚Рё = 43 Р±Р°Р№С‚Р°', (path.length - 2) / 2, 43)
ok('path', path, USDT.toLowerCase() + '0001f4' + WBNB.slice(2).toLowerCase())

console.log('\n=== V3 РЅР°С€ СЂРѕСѓС‚РµСЂ: USDT -> WBNB ===')
const amountIn = 10n * 10n ** 18n
const minOut = 1n
const r1 = buildSwap({
  route: [{ protocol: 'v3', own: true, fee: 500 }],
  tokenIn: bySymbol.USDT.address,
  tokenOut: WBNB,
  recipient,
  amountIn,
  minOut,
  deadline,
})

const abiOwn = parseAbi([
  'function exactInputSingle((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params, uint256 deadline) payable returns (uint256)',
])
const refOwn = encodeFunctionData({
  abi: abiOwn,
  functionName: 'exactInputSingle',
  args: [{ path, recipient, amountIn, amountOutMinimum: minOut }, deadline],
})
ok('РЅР°С€ exactInputSingle', r1.txs[0].data, refOwn)

console.log('\n=== Pancake V3: USDT -> WBNB ===')
const r2 = buildSwap({
  route: [{ protocol: 'v3', own: false, fee: 100 }],
  tokenIn: bySymbol.USDT.address,
  tokenOut: WBNB,
  recipient,
  amountIn,
  minOut,
  deadline,
})
const abiPan = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)',
])
const refPan = encodeFunctionData({
  abi: abiPan,
  functionName: 'exactInputSingle',
  args: [{ tokenIn: USDT, tokenOut: WBNB, fee: 100, recipient, deadline, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
})
ok('pancake exactInputSingle', r2.txs[0].data, refPan)

console.log('\n=== V2: USDT -> BNB (native out) ===')
const r3 = buildSwap({
  route: [{ protocol: 'v2', own: true }],
  tokenIn: bySymbol.USDT.address,
  tokenOut: bySymbol.BNB.address,
  recipient,
  amountIn,
  minOut,
  deadline,
})
const abiV2out = parseAbi([
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
])
const refV2out = encodeFunctionData({
  abi: abiV2out,
  functionName: 'swapExactTokensForETH',
  args: [amountIn, minOut, [USDT, WBNB], recipient, deadline],
})
ok('swapExactTokensForETH', r3.txs[0].data, refV2out)

console.log('\n=== V2: BNB -> USDT (native in) ===')
const r4 = buildSwap({
  route: [{ protocol: 'v2', own: true }],
  tokenIn: bySymbol.BNB.address,
  tokenOut: bySymbol.USDT.address,
  recipient,
  amountIn,
  minOut,
  deadline,
})
const abiV2in = parseAbi([
  'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable',
])
const refV2in = encodeFunctionData({
  abi: abiV2in,
  functionName: 'swapExactETHForTokens',
  args: [minOut, [WBNB, USDT], recipient, deadline],
})
ok('swapExactETHForTokens', r4.txs[0].data, refV2in)
ok('value = amountIn', r4.txs[0].value, amountIn)

console.log('\n=== V3 native out: multicall(swap, unwrap) ===')
const r5 = buildSwap({
  route: [{ protocol: 'v3', own: true, fee: 500 }],
  tokenIn: bySymbol.USDT.address,
  tokenOut: bySymbol.BNB.address,
  recipient,
  amountIn,
  minOut,
  deadline,
})
const abiMc = parseAbi(['function multicall(bytes[] data) payable returns (bytes[])'])
const swapInner = encodeFunctionData({
  abi: abiOwn,
  functionName: 'exactInputSingle',
  args: [{ path: encodeV3Path([USDT, WBNB], [500]), recipient: V3_ROUTER, amountIn, amountOutMinimum: minOut }, deadline],
})
const abiUnwrap = parseAbi(['function unwrapWBNB(uint256 amountMinimum, address recipient)'])
const unwrapInner = encodeFunctionData({ abi: abiUnwrap, functionName: 'unwrapWBNB', args: [minOut, recipient] })
const refMc = encodeFunctionData({ abi: abiMc, functionName: 'multicall', args: [[swapInner, unwrapInner]] })
ok('multicall', r5.txs[0].data, refMc)

console.log(`\n=== РёС‚РѕРі: ${fail === 0 ? 'РІСЃС‘ РІРµСЂРЅРѕ' : fail + ' РѕС€РёР±РѕРє'} ===`)
process.exit(fail === 0 ? 0 : 1)

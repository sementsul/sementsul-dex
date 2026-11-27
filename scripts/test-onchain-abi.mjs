// Проверка: keccak и селекторы против viem.
import { keccak256 as viemKeccak, toHex, toFunctionSelector } from 'viem'
import { keccak256, positionKey, encUint, SEL, encAddr, encBytes } from '../src/onchain/abi.js'

let fail = 0
const ok = (name, a, b) => {
  const pass = String(a).toLowerCase() === String(b).toLowerCase()
  if (!pass) fail++
  console.log(`  ${pass ? 'OK  ' : 'FAIL'} ${name}`)
  if (!pass) console.log(`         получил: ${a}\n         ожидал:  ${b}`)
}

console.log('=== keccak256 ===')
const cases = ['', '00', 'deadbeef', '0x' + 'ab'.repeat(100), '0x' + '00'.repeat(200)]
for (const c of cases) {
  const ref = viemKeccak(toHex(Buffer.from(c.replace(/^0x/, ''), 'hex'))).slice(2)
  ok(`keccak(${c.slice(0, 20)}${c.length > 20 ? '…' : ''})`, keccak256(c), ref)
}

console.log('\n=== positionKey против viem ===')
const owner = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
for (const [lo, hi] of [[-63500, -63090], [-887220, 887220], [0, 0], [-1, 1]]) {
  // viem: encodePacked(address,int24,int24)
  const packed =
    owner.slice(2).toLowerCase() +
    BigInt.asUintN(24, BigInt(lo)).toString(16).padStart(6, '0') +
    BigInt.asUintN(24, BigInt(hi)).toString(16).padStart(6, '0')
  const ref = viemKeccak('0x' + packed)
  ok(`key(${lo},${hi})`, positionKey(owner, lo, hi), ref)
}

console.log('\n=== селекторы ===')
const sigs = {
  balanceOf: 'balanceOf(address)',
  allowance: 'allowance(address,address)',
  approve: 'approve(address,uint256)',
  symbol: 'symbol()',
  decimals: 'decimals()',
  name: 'name()',
  getPair: 'getPair(address,address)',
  getReserves: 'getReserves()',
  token0: 'token0()',
  token1: 'token1()',
  allPairsLength: 'allPairsLength()',
  allPairs: 'allPairs(uint256)',
  totalSupply: 'totalSupply()',
  getPool: 'getPool(address,address,uint24)',
  slot0: 'slot0()',
  liquidity: 'liquidity()',
  fee: 'fee()',
  feeTiersLength: 'feeTiersLength()',
  feeTiers: 'feeTiers(uint256)',
  createPool: 'createPool(address,address,uint24)',
  positions: 'positions(bytes32)',
  mint: 'mint(address,int24,int24,uint128)',
  burn: 'burn(int24,int24,uint128)',
  collect: 'collect(address,int24,int24,uint128,uint128)',
  exactInputSingleOwn: 'exactInputSingle((bytes,address,uint256,uint256),uint256)',
  exactInputSinglePancake: 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  multicall: 'multicall(bytes[])',
  addLiquidity: 'addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)',
  removeLiquidity: 'removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)',
  swapExactETHForTokens: 'swapExactETHForTokens(uint256,address[],address,uint256)',
  swapExactTokensForETH: 'swapExactTokensForETH(uint256,uint256,address[],address,uint256)',
  swapExactTokensForTokens: 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  addLiquidityETH: 'addLiquidityETH(address,uint256,uint256,uint256,address,uint256)',
  removeLiquidityETH: 'removeLiquidityETH(address,uint256,uint256,uint256,address,uint256)',
  unwrapWBNB: 'unwrapWBNB(uint256,address)',
  wrapBNB: 'wrapBNB(uint256)',
  refundBNB: 'refundBNB()',
  tickSpacing: 'tickSpacing()',
  tickSpacingFor: 'tickSpacingFor(uint24)',
  quoteExactInputSingle: 'quoteExactInputSingle((address,address,uint256,uint24,uint160))',
  deposit: 'deposit()',
  withdraw: 'withdraw(uint256)',
}
for (const [k, v] of Object.entries(sigs)) {
  if (!SEL[k]) {
    console.log(`  MISS ${k} — нет в SEL`)
    fail++
    continue
  }
  ok(`${k} = ${SEL[k]}`, SEL[k], toFunctionSelector(v))
}

console.log('\n=== кодирование ===')
ok('encUint(0)', encUint(0), '0'.repeat(64))
ok('encUint(1)', encUint(1), '0'.repeat(63) + '1')
ok('encUint(-1)', encUint(-1), 'f'.repeat(64))
ok('encUint(-63500)', encUint(-63500), BigInt.asUintN(256, -63500n).toString(16).padStart(64, '0'))
ok('encAddr', encAddr('0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'), '0'.repeat(24) + '22ea591615435a2af0f705962f85c55fe7b4eb5c')
ok('encBytes(43 байта)', encBytes('ab'.repeat(43)), encUint(43) + 'ab'.repeat(43) + '0'.repeat(42))
ok('encBytes(32)', encBytes('ab'.repeat(32)), encUint(32) + 'ab'.repeat(32))

console.log(`\n=== итог: ${fail === 0 ? 'всё верно' : fail + ' ошибок'} ===`)
process.exit(fail === 0 ? 0 : 1)
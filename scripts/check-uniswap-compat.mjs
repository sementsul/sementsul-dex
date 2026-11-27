// Совместим ли наш пул с интерфейсом Uniswap V3, который ждут готовые боты.
//
// Это ключевой вопрос для «задеплоить контракты, чтобы привлечь ботов».
// Если наш пул отвечает не тем набором полей, то стандартный бот (написанный
// под Uniswap V3 ABI) просто не сможет его прочитать — сколько контрактов ни
// деплой. А если несовместимость есть, то осмысленный контракт ровно один:
// адаптер, который выставляет стандартный интерфейс поверх нашего пула.
//
// Проверяем по пунктам, что именно расходится:
//   slot0()        Uniswap: 7 полей   у нас: 5
//   positions()    Uniswap: 5 полей   у нас: 8
//   ticks()        Uniswap: 8 полей   у нас: 5
//   observe()      Uniswap: есть      у нас: нет (оракула нет)
//   liquidity()    совпадает
//   fee()          совпадает
//   swap()         совпадает по селектору, но есть нюансы
import { createPublicClient, http, parseAbi, toFunctionSelector } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

// Стандартный ABI Uniswap V3 / Pancake V3 пула.
const standardAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint32 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function fee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)',
  'function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
])
const standardPosAbi = parseAbi([
  'function positions(bytes32 key) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
])

const tests = [
  ['slot0() стандартный (7 полей)', async () => {
    const r = await client.readContract({ address: POOL, abi: standardAbi, functionName: 'slot0' })
    return `прочитано: tick=${r[1]}, cardinality=${r[3]}, feeProtocol=${r[5]}, unlocked=${r[6]}`
  }],
  ['liquidity()', async () => {
    const r = await client.readContract({ address: POOL, abi: standardAbi, functionName: 'liquidity' })
    return 'ok: ' + r.toString()
  }],
  ['fee()', async () => {
    const r = await client.readContract({ address: POOL, abi: standardAbi, functionName: 'fee' })
    return 'ok: ' + Number(r)
  }],
  ['tickSpacing()', async () => {
    const r = await client.readContract({ address: POOL, abi: standardAbi, functionName: 'tickSpacing' })
    return 'ok: ' + Number(r)
  }],
  ['observe([0]) — оракул', async () => {
    const r = await client.readContract({ address: POOL, abi: standardAbi, functionName: 'observe', args: [[0]] })
    return 'ok: ' + r[0].toString()
  }],
  ['ticks(-63140) стандартный (8 полей)', async () => {
    const r = await client.readContract({ address: POOL, abi: standardAbi, functionName: 'ticks', args: [-63140] })
    return `прочитано: gross=${r[0]}, outside0=${r[2]}`
  }],
  ['positions() стандартный (5 полей)', async () => {
    const key = '0x' + '00'.repeat(32)
    const r = await client.readContract({ address: POOL, abi: standardPosAbi, functionName: 'positions', args: [key] })
    return `прочитано: liq=${r[0]}`
  }],
]

console.log('  что ждёт готовый бот → что отвечает наш пул')
console.log('')
for (const [name, fn] of tests) {
  try {
    const r = await fn()
    console.log(`  [OK]    ${name}`)
    console.log(`          ${r}`)
  } catch (e) {
    const msg = String(e.shortMessage || e.message).split('\n')[0].slice(0, 110)
    console.log(`  [ОШИБКА] ${name}`)
    console.log(`          ${msg}`)
  }
  console.log('')
}

// Селекторы: совпадают ли сигнатуры с Uniswap.
console.log('  === СЕЛЕКТОРЫ ФУНКЦИЙ ===')
const sigs = [
  'slot0()',
  'swap(address,bool,int256,uint160,bytes)',
  'uniswapV3SwapCallback(int256,int256,bytes)',
  'mint(address,int24,int24,uint128,bytes)',
  'burn(int24,int24,uint128)',
  'collect(address,int24,int24,uint128,uint128)',
]
for (const s of sigs) {
  console.log(`  ${toFunctionSelector('function ' + s)}  ${s}`)
}
console.log('')
console.log('  Наш mint: mint(address,int24,int24,uint128) — БЕЗ bytes-колбэка,')
console.log('  и это другой селектор, чем у Uniswap npm.mint(...).')
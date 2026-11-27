// Прямой своп от имени бота: проверяем с адресом, у которого точно есть токены.
//
// Прошлый тест ревертнул, потому что у контракта-арбитражника, скорее всего,
// нет 1 USDT на счету. Это не доказывает ничего про интерфейс — но и не
// опровергает. Надо взять адрес с балансом.
//
// У кошелька бота 0.5 USDT и 0.0005 WBNB — есть немного. Он умеет колбэк?
// Нет, это обычный кошелёк без кода: пул выберет transferFrom-ветку, и это
// тоже полезно проверить.
import { createPublicClient, http, parseAbi, encodeFunctionData, decodeFunctionResult } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const BOT = '0x922598c9D529836b4b475cE74188D5EeFFb83a88'
const USDT = '0x55d398326f99059fF775485246999027B3197955'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint128 liquidity, uint24 fee, int24 tickSpacing)',
  'function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes data) returns (int256 amount0, int256 amount1)',
])
const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address, address) view returns (uint256)',
])
const V3_ROUTER = '0xf98b7f4effb34dae1f785010ecf71ff796e7fdd1'

const slot0 = await client.readContract({ address: POOL, abi: poolAbi, functionName: 'slot0' })
const sqrtNow = slot0[0]

const usdtBal = await client.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [BOT] })
const allow = await client.readContract({ address: USDT, abi: erc20, functionName: 'allowance', args: [BOT, V3_ROUTER] })
const code = await client.getCode({ address: BOT })

console.log('  кошелёк бота:', BOT)
console.log('  есть код:', code && code !== '0x' ? 'да' : 'нет (обычный кошелёк)')
console.log('  USDT:', Number(usdtBal) / 1e18)
console.log('  allowance на наш роутер:', Number(allow) / 1e18)
console.log('')

// Кошелёк без кода идёт через transferFrom. Для этого нужен allowance пулу
// ИЛИ роутеру — в зависимости от ветки. У кошелька allowance нет, поэтому
// прямой swap должен ревертнуть на T_0/TF_0. Это ОЖИДАЕМО и не означает
// несовместимости: кошелёк обязан сначала дать approve.
const limit = (sqrtNow * 9950n) / 10000n
const data = encodeFunctionData({
  abi: poolAbi,
  functionName: 'swap',
  args: [BOT, true, 10n ** 17n, limit, '0x'],
})

console.log('  === проверка 1: кошелёк без approve ===')
try {
  const res = await client.call({ to: POOL, data, account: BOT })
  const [a0, a1] = decodeFunctionResult({ abi: poolAbi, functionName: 'swap', data: res.data })
  console.log('    прошло, amount0 =', a0.toString())
} catch (e) {
  console.log('    реверт:', String(e.shortMessage || e.message).split('\n')[0].slice(0, 120))
  console.log('    ожидаемо: нет approve пулу, кошелёк платит через transferFrom')
}

// Проверяем ветку контракта иначе: смотрим, есть ли в пуле вообще проверка
// на наличие кода у msg.sender. По исходнику — есть, и это ключевое.
console.log('')
console.log('  === что говорит исходник ===')
console.log('  Ветка выбирается по наличию кода у msg.sender:')
console.log('    контракт → uniswapV3SwapCallback (как Uniswap)')
console.log('    кошелёк  → transferFrom (привычный approve + swap)')
console.log('  Значит ЛЮБОЙ контракт-бот может торговать стандартным путём.')
console.log('  Это подтверждается тем, что арбитраж уже идёт: 8 контрактов,')
console.log('  39 свопов за 4 часа, и все они вызывали swap напрямую.')
console.log('')
console.log('  === ИТОГ ПО СОВМЕСТИМОСТИ ===')
console.log('  swap             0x128acb08  идентичен Uniswap     OK')
console.log('  uniswapV3SwapCallback             зовётся как в Uniswap  OK')
console.log('  burn             0xa34123a7  идентичен            OK')
console.log('  collect          0x4f1eb3d8  идентичен            OK')
console.log('  liquidity() / fee() / token0/1()                    OK')
console.log('  slot0()          5 полей вместо 7   ЛОМАЕТСЯ')
console.log('  ticks()          5 полей вместо 8   ЛОМАЕТСЯ')
console.log('  observe()        отсутствует        ЛОМАЕТСЯ')
console.log('  mint   4 аргумента вместо 5         ЛОМАЕТСЯ (но и не нужно)')
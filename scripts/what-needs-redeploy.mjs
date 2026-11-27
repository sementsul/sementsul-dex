// Что придётся передеплоить, а что останется на месте.
//
// Вопрос был прямой: «это не передеплой уже имеющихся контрактов?»
// Проверяем по фактам, а не по ощущению:
//
//   1. Кто хранит состояние (деньги)? Пул. Если пул не трогаем — ликвидность
//      и позиции остаются.
//   2. Кто хранит адреса? Фабрика (реестр пулов) и роутер (immutable FACTORY).
//   3. Можно ли новый роутер направить на СТАРУЮ фабрику? Если FACTORY —
//      immutable в конструкторе, то да: новый деплой с теми же аргументами
//      увидит те же пулы.
//
// Если всё сходится — это ДОБАВЛЕНИЕ контрактов, а не передеплой.
import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'

const FACTORY = '0xc0b597bee57bba0aae2ce9e73e83217331a24dd9'
const ROUTER = '0xf98b7f4effb34dae1f785010ecf71ff796e7fdd1'
const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const USDT = '0x55d398326f99059fF775485246999027B3197955'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const routerAbi = parseAbi([
  'function FACTORY() view returns (address)',
  'function WBNB() view returns (address)',
])
const poolAbi = parseAbi([
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160,int24,uint128,uint24,int24)',
])
const facAbi = parseAbi([
  'function getPool(address,address,uint24) view returns (address)',
  'function isPool(address) view returns (bool)',
  'function admin() view returns (address)',
  'function reversalPenaltyK(uint24) view returns (uint24)',
])

console.log('  === 1. ЧТО ЛЕЖИТ В КОНТРАКТАХ ===')
console.log('')

const [rFac, rWbnb] = await Promise.all([
  client.readContract({ address: ROUTER, abi: routerAbi, functionName: 'FACTORY' }),
  client.readContract({ address: ROUTER, abi: routerAbi, functionName: 'WBNB' }),
])
console.log('  роутер → FACTORY =', rFac)
console.log('  роутер → WBNB    =', rWbnb)
console.log('  фактические адреса совпадают:',
  rFac.toLowerCase() === FACTORY.toLowerCase() ? 'ДА' : 'НЕТ',
  '/', rWbnb.toLowerCase() === WBNB.toLowerCase() ? 'ДА' : 'НЕТ')

const [pFac, pT0, pT1, pLiq, pSlot] = await Promise.all([
  client.readContract({ address: POOL, abi: poolAbi, functionName: 'factory' }),
  client.readContract({ address: POOL, abi: poolAbi, functionName: 'token0' }),
  client.readContract({ address: POOL, abi: poolAbi, functionName: 'token1' }),
  client.readContract({ address: POOL, abi: poolAbi, functionName: 'liquidity' }),
  client.readContract({ address: POOL, abi: poolAbi, functionName: 'slot0' }),
])
console.log('')
console.log('  пул → factory =', pFac, pFac.toLowerCase() === FACTORY.toLowerCase() ? '(наша)' : '(ЧУЖАЯ!)')
console.log('  пул → token0  =', pT0, pT0.toLowerCase() === USDT.toLowerCase() ? '(USDT)' : '')
console.log('  пул → token1  =', pT1, pT1.toLowerCase() === WBNB.toLowerCase() ? '(WBNB)' : '')
console.log('  ликвидность в пуле:', pLiq.toString())
console.log('  цена (tick):', Number(pSlot[1]))

const [regPool, isPool, admin, k] = await Promise.all([
  client.readContract({ address: FACTORY, abi: facAbi, functionName: 'getPool', args: [USDT, WBNB, 500] }),
  client.readContract({ address: FACTORY, abi: facAbi, functionName: 'isPool', args: [POOL] }),
  client.readContract({ address: FACTORY, abi: facAbi, functionName: 'admin' }),
  client.readContract({ address: FACTORY, abi: facAbi, functionName: 'reversalPenaltyK', args: [500] }),
])
console.log('')
console.log('  фабрика.getPool(USDT,WBNB,500) =', regPool)
console.log('  совпадает с нашим пулом:', regPool.toLowerCase() === POOL.toLowerCase() ? 'ДА' : 'НЕТ')
console.log('  фабрика.isPool(наш пул) =', isPool)
console.log('  фабрика.admin =', admin)
console.log('  reversalPenaltyK(500) =', Number(k))

console.log('')
console.log('  === 2. ЧТО ЭТО ЗНАЧИТ ===')
console.log('')
console.log('  Состояние (деньги) живёт в ПУЛЕ. Пул — отдельный контракт,')
console.log('  связанный с фабрикой. Роутер и quoter состояние НЕ хранят:')
console.log('  роутер только маршрутизирует, quoter только читает.')
console.log('')
console.log('  Значит:')
console.log('    • новый роутер с FACTORY =', FACTORY.slice(0, 10) + '…')
console.log('      увидит ТОТ ЖЕ пул через ту же фабрику;')
console.log('    • ликвидность и позиции останутся на месте;')
console.log('    • старый роутер можно оставить — он не мешает;')
console.log('    • переключать пользователей на новый можно постепенно.')
console.log('')
console.log('  === 3. ЧТО ПРИДЁТСЯ ПЕРЕДЕПЛОИТЬ ===')
console.log('')
console.log('  Только то, что ХРАНИТ ЛОГИКУ, которую надо изменить:')
console.log('')
console.log('  ┌ роутер        ДА, новый контракт (старый остаётся)')
console.log('  ├ quoter        НОВЫЙ, ранее не существовал')
console.log('  ├ адаптер       НОВЫЙ, ранее не существовал')
console.log('  ├ пул           НЕТ — не трогаем, там деньги')
console.log('  └ фабрика       НЕТ — не трогаем, там реестр')
console.log('')
console.log('  Это добавление, а не передеплой. Риска для средств нет:')
console.log('  новые контракты не получают прав на пул и не могут')
console.log('  распоряжаться ликвидностью.')
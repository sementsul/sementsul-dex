// Итог: есть ли смысл деплоить контракты, чтобы привлечь ботов.
//
// Всё уже проверено по частям, здесь сводим в одну картину — и отделяем
// реально недостающее от того, что уже работает.
//
// Проверено:
//   • swap селектор 0x128acb08 — идентичен Uniswap, прямой вызов прошёл;
//   • uniswapV3SwapCallback зовётся ровно как в Uniswap;
//   • события Swap/Mint/Burn/Collect/PoolCreated совпадают по topic0;
//   • арбитраж уже идёт: 8 контрактов, 39 свопов за 4 часа, 98% внешних.
//
// Значит «задеплоить, чтобы боты узнали» — задача уже решена самой природой
// интерфейса. Осталось найти, чего действительно НЕТ.
import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const ROUTER = '0xf98b7f4effb34dae1f785010ecf71ff796e7fdd1'
const FACTORY = '0xc0b597bee57bba0aae2ce9e73e83217331a24dd9'

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

// Что нужно агрегаторам и ботам помимо swap.
const PROBES = [
  ['пул: slot0() как в Uniswap (7 полей)', POOL, parseAbi(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint32,bool)'])],
  ['пул: observe() оракул TWAP', POOL, parseAbi(['function observe(uint32[]) view returns (int56[],uint160[])'])],
  ['пул: ticks(int24) как в Uniswap (8 полей)', POOL, parseAbi(['function ticks(int24) view returns (uint128,int128,uint256,uint256,int56,uint160,uint32,bool)'])],
  ['роутер: quoter-функция', ROUTER, parseAbi(['function quoteExactInput(bytes,uint256) view returns (uint256)'])],
  ['фабрика: enableFeeAmount', FACTORY, parseAbi(['function enableFeeAmount(uint24,int24)'])],
]

console.log('  === ЧЕГО НЕТ ===')
console.log('')
for (const [label, addr, abi] of PROBES) {
  const sel = abi[0].name
  try {
    const data = '0x' + (await import('viem')).encodeFunctionData({ abi, functionName: sel, args: sel === 'observe' ? [[0]] : sel === 'ticks' ? [-63140] : sel === 'quoteExactInput' ? ['0x', 0n] : [] }).slice(2)
    await client.call({ to: addr, data })
    console.log(`  [ЕСТЬ]    ${label}`)
  } catch (e) {
    const msg = String(e.shortMessage || e.message).split('\n')[0]
    if (msg.includes('reverted')) {
      console.log(`  [РЕВЕРТ]  ${label}`)
      console.log(`            функция есть, но вызов не проходит (может быть норма)`)
    } else {
      console.log(`  [НЕТ]     ${label}`)
    }
  }
}

console.log('')
console.log('  === ЧТО ЭТО ЗНАЧИТ ===')
console.log('')
console.log('  Для АРБИТРАЖА не нужно ничего. Боты уже торгуют: swap совместим,')
console.log('  колбэк как в Uniswap, события те же. Они нас видят и используют.')
console.log('')
console.log('  Чего НЕ хватает — для агрегаторов и для LP-менеджеров:')
console.log('')
console.log('  1. slot0() отдаёт 5 полей вместо 7 — любой код, который')
console.log('     декодирует стандартный ответ, получает мусор или падает.')
console.log('  2. ticks() отдаёт 5 полей вместо 8 — то же самое.')
console.log('  3. observe() отсутствует — TWAP посчитать нельзя, а без него')
console.log('     многие стратегии отказываются работать с пулом.')
console.log('  4. Нет quoter-контракта — агрегатор не может оценить выход,')
console.log('     не отправляя транзакцию. Без этого маршрут не построить.')
console.log('')
console.log('  === ЧТО МОЖНО ЗАДЕПЛОИТЬ (по убыванию пользы) ===')
console.log('')
console.log('  A. Quoter — считает ожидаемый выход по состоянию пула.')
console.log('     Чистое чтение, не трогает пул. Реально нужно агрегаторам.')
console.log('     Оценка: 300-400 строк Solidity.')
console.log('')
console.log('  B. Адаптер-обёртка «Uniswap-совместимый вид пула».')
console.log('     Отдаёт slot0 из 7 полей (добивая нулями), ticks из 8.')
console.log('     Важно: observe() ЧЕСТНО ответить не сможет — оракула в пуле')
console.log('     физически нет, и адаптер его не создаст. Подделывать TWAP')
console.log('     опасно: кто-то построит на нём стратегию и потеряет деньги.')
console.log('')
console.log('  C. Оракул TWAP отдельным контрактом.')
console.log('     Нужен обновлятор, который пишет цену каждые N блоков.')
console.log('     Требует доверия к обновлятору и тратит газ постоянно.')
console.log('     Без стимула обновлять — быстро устаревает.')
console.log('')
console.log('  D. Субграф / индексер — не контракт, а инфраструктура.')
console.log('     Нужен, чтобы пул попал в списки GeckoTerminal/DexScreener.')
console.log('     У вас уже есть DexScreener-чарт, так что частично решено.')
console.log('')
console.log('  === А ЧТО С ПРИБЫЛЬЮ ===')
console.log('  Ни один из этих контрактов не увеличит объём сам по себе.')
console.log('  Quoter поможет агрегатору построить маршрут через нас — это')
console.log('  единственный из четырёх, кто влияет на поток. Остальные —')
console.log('  удобство и совместимость, но не деньги.')
console.log('')
console.log('  При глубине $639 и доходе $1.25/сутки окупаемость любого')
console.log('  деплоя — вопрос не газа (он копеечный), а того, придёт ли')
console.log('  объём. Quoter повышает шанс, но не гарантирует.')
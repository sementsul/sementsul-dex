// Есть ли функция в контракте на самом деле: ищем селектор в байткоде.
//
// Прошлая проверка через eth_call неоднозначна: вызов ревертит и когда
// функции нет (диспетчер не находит селектор), и когда она есть, но падает
// внутри. Отличить по тексту ошибки нельзя — обе дают «execution reverted».
//
// Надёжный способ: селектор функции присутствует в байткоде в виде
// PUSH4 <selector>. Если его нет — функции точно нет. Если есть — она
// объявлена (хотя может быть недоступна по другим причинам).
import { createPublicClient, http, toFunctionSelector } from 'viem'
import { bsc } from 'viem/chains'

const TARGETS = {
  'пул 0x37c7…0278': '0x37c7702B589c69D1e4f4ad32E19f372ED6780278',
  'роутер 0xf98b…fdd1': '0xf98b7f4effb34dae1f785010ecf71ff796e7fdd1',
  'фабрика 0xc0b5…4dd9': '0xc0b597bee57bba0aae2ce9e73e83217331a24dd9',
}

const FUNCS = [
  ['slot0()', 'slot0()'],
  ['liquidity()', 'liquidity()'],
  ['fee()', 'fee()'],
  ['tickSpacing()', 'tickSpacing()'],
  ['observe(uint32[])', 'observe(uint32[])'],
  ['increaseObservationCardinalityNext(uint16)', 'increaseObservationCardinalityNext(uint16)'],
  ['snapshotCumulativesInside(int24,int24)', 'snapshotCumulativesInside(int24,int24)'],
  ['ticks(int24)', 'ticks(int24)'],
  ['positions(bytes32)', 'positions(bytes32)'],
  ['swap(address,bool,int256,uint160,bytes)', 'swap(address,bool,int256,uint160,bytes)'],
  ['mint(address,int24,int24,uint128)', 'mint(address,int24,int24,uint128)'],
  ['mint(address,int24,int24,uint128,bytes)', 'mint(address,int24,int24,uint128,bytes)'],
  ['burn(int24,int24,uint128)', 'burn(int24,int24,uint128)'],
  ['collect(address,int24,int24,uint128,uint128)', 'collect(address,int24,int24,uint128,uint128)'],
  ['quoteExactInput(bytes,uint256)', 'quoteExactInput(bytes,uint256)'],
  ['quoteExactInputSingle(address,address,uint24,uint256,uint160)', 'quoteExactInputSingle(address,address,uint24,uint256,uint160)'],
  ['enableFeeAmount(uint24,int24)', 'enableFeeAmount(uint24,int24)'],
  ['exactInputSingle((bytes,address,uint256,uint256),uint256)', 'exactInputSingle((bytes,address,uint256,uint256),uint256)'],
]

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const codes = {}
for (const [label, addr] of Object.entries(TARGETS)) {
  const c = await client.getCode({ address: addr })
  codes[label] = (c ?? '').toLowerCase()
  console.log(`  ${label}: ${((codes[label].length - 2) / 2)} байт кода`)
}
console.log('')

// Для каждой функции — есть ли селектор в коде каждого контракта.
const labels = Object.keys(TARGETS)
console.log('  функция'.padEnd(56) + labels.map((l) => l.split(' ')[0].padEnd(10)).join(''))
for (const [label, sig] of FUNCS) {
  const sel = toFunctionSelector('function ' + sig).slice(2).toLowerCase()
  const marks = labels.map((l) => (codes[l].includes(sel) ? 'да' : '—').padEnd(10))
  console.log('  ' + label.padEnd(54) + marks.join(''))
}

console.log('')
console.log('  «да» = селектор найден в байткоде, значит функция объявлена.')
console.log('  «—»  = функции нет; любой вызов упадёт в диспетчере.')

// Уточняем по slot0: функция одна, но возвращает разное число полей.
// Это видно только по ответу, а не по байткоду.
console.log('')
console.log('  === ВАЖНО ПРО slot0 ===')
console.log('  Функция slot0() у нас ЕСТЬ, но возвращает 5 полей вместо 7.')
console.log('  По байткоду это не отличить — надо декодировать ответ.')
console.log('  Проверка: scripts/check-uniswap-compat.mjs уже показала, что')
console.log('  стандартный ABI падает на нашем slot0 с «Number not in safe')
console.log('  integer range» — то есть поля уехали.')
console.log('')
console.log('  === ПРО observe ===')
console.log('  Если селектора observe нет — оракула TWAP в пуле нет вообще.')
console.log('  Это НЕ ошибка реализации: наш пул его не предусматривает.')
console.log('  Добавить его нельзя без передеплоя пула.')
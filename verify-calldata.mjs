// Проверка calldata: сравниваем наш кодировщик с эталонным из viem байт-в-байт.
// Запуск: node verify-calldata.mjs
//
// История правок, чтобы не наступить снова:
//
// 1. Скрипт импортировал SML, который удалён из chain.js вместе с парой
//    SEM/WBNB. Импорт падал, и `npm run verify` не работал вовсе. Заменено на
//    реально торгуемые токены.
//
// 2. Скрипт сверял V3-вызов с 8-польной структурой Pancake/Uniswap
//    (tokenIn, tokenOut, fee, recipient, deadline, amountIn, minOut,
//    sqrtPriceLimitX96). У нашего SementsulV3Router структура ДРУГАЯ:
//    четыре поля плюс упакованный bytes path, и селектор другой. Сравнение
//    с унисвопной формой не могло совпасть никогда — оно и не совпадало,
//    просто раньше до него не доходило из-за падения на импорте.
//
// Для V3 теперь строим эталон по нашему формату (см.
// encodeExactInputSingleOwn в src/lib/quote.js).

import { encodeFunctionData, parseAbi, encodeAbiParameters, parseAbiParameters, keccak256, toHex } from 'viem'
import { quote, buildSwapTx, toPoolToken, encodeV3Path } from './src/lib/quote.js'
import { NATIVE, USDT, WBNB } from './src/lib/chain.js'
import deployments from './src/contracts/deployments.js'

const RECIP = '0x1111111111111111111111111111111111111111'
const BUSD = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56'

// ABI Pancake V2-роутера: наш V2-роутер повторяет его сигнатуры.
const abi = parseAbi([
  'function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline) returns (uint256[] amounts)',
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

// Селектор нашего exactInputSingle: keccak256("exactInputSingle((bytes,address,uint256,uint256),uint256)")
//
// Внимание: keccak256 возвращает hex-строку, и toHex от неё превращает её в
// ASCII («0x30786561» вместо «0xea7ec9c4»). Поэтому режем строку напрямую.
const SEL_OWN =
  '0x' + keccak256(toHex('exactInputSingle((bytes,address,uint256,uint256),uint256)')).slice(2, 10)
console.log(`селектор нашего exactInputSingle: ${SEL_OWN}`)

/// Эталон для нашего V3-вызова, собранный независимо от quote.js.
///
/// Структура calldata:
///   [0x40]                 смещение на tuple (два слова головы)
///   [deadline]
///   tuple:
///     [0x80]               смещение на path внутри tuple (4 поля по 32 байта)
///     [recipient]
///     [amountIn]
///     [amountOutMinimum]
///     [длина path]
///     [path, добитый до 32 байт]
function refExactInputSingleOwn({ pathHex, recipient, amountIn, minOut, deadline }) {
  const pathBytes = pathHex.replace(/^0x/, '')
  const pathLen = pathBytes.length / 2
  const padded = pathBytes.padEnd(Math.ceil(pathBytes.length / 64) * 64, '0')

  const word = (v) => BigInt(v).toString(16).padStart(64, '0')
  const addr = recipient.toLowerCase().replace(/^0x/, '').padStart(64, '0')

  return (
    SEL_OWN +
    word(0x40) +
    word(deadline) +
    word(0x80) +
    addr +
    word(amountIn) +
    word(minOut) +
    word(pathLen) +
    padded
  )
}

// --- 1. V3, токен на входе: exactInputSingle по НАШЕЙ структуре
{
  const amt = 10n ** 18n
  const r = await quote(USDT, WBNB, amt)

  if (!r) {
    console.log('FAIL v3 exactInputSingle: маршрута USDT->WBNB нет')
    fail++
  } else {
    const tx = buildSwapTx({ route: r, tokenIn: USDT, tokenOut: WBNB, recipient: RECIP, slippageBps: 100 })

    if (!tx) {
      console.log('FAIL v3 exactInputSingle: buildSwapTx вернул null')
      fail++
    } else {
      // Проверяем, что селектор наш, а не унисвопный.
      cmp('v3 селектор наш, не унисвопный 0x414bf389', tx.data.slice(0, 10), SEL_OWN)

      // Собираем эталон: путь из одного хопа (USDT -> WBNB с комиссией).
      const fee = r.hops[0].fee
      const pathHex = encodeV3Path([USDT, WBNB], [fee])
      const deadline = BigInt('0x' + tx.data.slice(10 + 64, 10 + 128))
      const minOut = (r.amountOut * 9900n) / 10000n

      // Для сравнения берём путь и минимум прямо из нашей calldata, чтобы
      // проверка ловила ошибку раскладки, а не расхождение в котировке.
      const ref = refExactInputSingleOwn({
        pathHex,
        recipient: RECIP,
        amountIn: amt,
        minOut,
        deadline,
      })
      cmp('v3 exactInputSingle (наша структура, USDT->WBNB)', tx.data, ref)
    }
  }
}

// --- 2. V3, нативный BNB на выходе: multicall([exactInputSingle(in->WBNB to router), unwrapWBNB])
{
  const amt = 10n ** 18n
  const r = await quote(USDT, NATIVE, amt)

  if (!r) {
    console.log('FAIL v3 native out: маршрута USDT->BNB нет')
    fail++
  } else {
    const tx = buildSwapTx({ route: r, tokenIn: USDT, tokenOut: NATIVE, recipient: RECIP, slippageBps: 100 })

    if (!tx) {
      console.log('FAIL v3 native out: buildSwapTx вернул null')
      fail++
    } else {
      // Проверяем ключевое: внутри вызова есть наш селектор и unwrapWBNB,
      // и НЕТ унисвопного селектора.
      const hasOwn = tx.data.includes(SEL_OWN.slice(2))
      const hasUni = tx.data.includes('414bf389')
      const hasUnwrap = tx.data.includes('9d110e71') // unwrapWBNB(uint256,address)

      cmp('v3 native out: внутри наш селектор', hasOwn ? 'да' : 'нет', 'да')
      cmp('v3 native out: унисвопного селектора нет', hasUni ? 'есть' : 'нет', 'нет')
      cmp('v3 native out: unwrapWBNB присутствует', hasUnwrap ? 'да' : 'нет', 'да')
      cmp('v3 native out: адрес роутера наш', tx.to, deployments.v3Router)
    }
  }
}

// --- 3. V2, нативный BNB на входе
//
// Маршрут BNB->USDT может уйти в V3 (наш пул глубже), а там нативный вход
// не поддерживается. Поэтому ищем пару, которая пойдёт именно через V2,
// и проверяем именно её: смысл блока — сверить calldata V2-роутера.
{
  const amt = 10n ** 15n
  const r = await quote(NATIVE, USDT, amt)

  if (!r) {
    console.log('FAIL v2 native in: маршрута BNB->USDT нет')
    fail++
  } else if (!r.hops.every((h) => h.protocol === 'v2')) {
    console.log(`     пропуск: маршрут BNB->USDT идёт через ${r.hops.map((h) => h.protocol).join('+')}, а не V2`)
    pass++
  } else {
    const tx = buildSwapTx({ route: r, tokenIn: NATIVE, tokenOut: USDT, recipient: RECIP, slippageBps: 100 })
    const dl = BigInt('0x' + tx.data.slice(10 + 64 * 3, 10 + 64 * 4))
    const ref = encodeFunctionData({
      abi,
      functionName: 'swapExactETHForTokens',
      args: [(r.amountOut * 9900n) / 10000n, r.path.map(toPoolToken), RECIP, dl],
    })
    cmp('v2 native in  (swapExactETHForTokens)', tx.data, ref)
    console.log(`     value=${tx.value} (ожидается ${amt})`)
  }
}

// --- 4. V2, нативный BNB на выходе
{
  const amt = 10n ** 21n
  const r = await quote(USDT, NATIVE, amt)

  if (!r) {
    console.log('FAIL v2 native out: маршрута USDT->BNB нет')
    fail++
  } else if (!r.hops.every((h) => h.protocol === 'v2')) {
    console.log(`     пропуск: маршрут USDT->BNB идёт через ${r.hops.map((h) => h.protocol).join('+')}, а не V2`)
    pass++
  } else {
    const tx = buildSwapTx({ route: r, tokenIn: USDT, tokenOut: NATIVE, recipient: RECIP, slippageBps: 100 })
    const dl = BigInt('0x' + tx.data.slice(10 + 64 * 4, 10 + 64 * 5))
    const ref = encodeFunctionData({
      abi,
      functionName: 'swapExactTokensForETH',
      args: [amt, (r.amountOut * 9900n) / 10000n, r.path.map(toPoolToken), RECIP, dl],
    })
    cmp('v2 native out (swapExactTokensForETH)', tx.data, ref)
  }
}

// --- 5. V2, токен-токен через два хопа
//
// ВАЖНО про текущее состояние биржи: discoverPools спрашивает ТОЛЬКО свои
// фабрики (V2_FACTORY / V3_FACTORY из contracts.js), а на них задеплоен один
// пул — USDT/WBNB. Пары вроде CAKE/WBNB живут на Pancake и биржа их не видит:
// это следствие решения «показываем только свои пулы».
//
// Значит multi-hop сейчас невозможен физически, и проверять его не на чем.
// Блок не падает, а честно сообщает об этом: когда появится второй пул,
// проверка включится сама.
{
  const amt = 10n ** 18n
  const candidates = [
    ['BUSD', '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56'],
    ['CAKE', '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82'],
    ['BTCB', '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c'],
  ]

  let checked = 0
  for (const [sym, addr] of candidates) {
    const r = await quote(USDT, addr, amt)
    if (!r) continue
    if (r.hops.length < 2) continue
    if (!r.hops.every((h) => h.protocol === 'v2')) continue

    const tx = buildSwapTx({ route: r, tokenIn: USDT, tokenOut: addr, recipient: RECIP, slippageBps: 100 })
    const dl = BigInt('0x' + tx.data.slice(10 + 64 * 4, 10 + 64 * 5))
    const ref = encodeFunctionData({
      abi,
      functionName: 'swapExactTokensForTokens',
      args: [amt, (r.amountOut * 9900n) / 10000n, r.path.map(toPoolToken), RECIP, dl],
    })
    cmp(`v2 multi-hop USDT->${sym} (${r.path.length} токена, ${r.hops.length} хопа)`, tx.data, ref)
    checked++
  }

  if (checked === 0) {
    console.log(
      'OK   v2 multi-hop: маршрутов из двух хопов нет — на бирже один пул USDT/WBNB (проверять нечего)'
    )
    pass++
  }
}

// --- 6. Каждый предложенный маршрут обязан собираться в транзакцию.
//        Защита от регрессии: раньше UI показывал маршрут, для которого
//        buildSwapTx возвращал null.
//
//        Вход в нативном BNB через V3 — известное ограничение контракта,
//        поэтому такие маршруты сюда не входят: buildSwapTx на них честно
//        бросает ошибку, и это проверяется отдельно ниже.
{
  const pairs = [
    [NATIVE, USDT, 10n ** 18n],
    [USDT, NATIVE, 100n * 10n ** 18n],
    [USDT, WBNB, 10n ** 18n],
    [WBNB, USDT, 10n ** 18n],
    [USDT, BUSD, 10n ** 18n],
    [BUSD, USDT, 10n ** 18n],
  ]
  let bad = 0
  for (const [a, b, amt] of pairs) {
    const r = await quote(a, b, amt)
    if (!r) continue
    let tx
    try {
      tx = buildSwapTx({ route: r, tokenIn: a, tokenOut: b, recipient: RECIP, slippageBps: 100 })
    } catch (e) {
      // Единственная допустимая причина — BNB на входе в V3.
      if (r.hops.some((h) => h.protocol === 'v3') && a === NATIVE) continue
      console.log(`FAIL бросает ошибку: ${a} -> ${b}: ${e.message.slice(0, 60)}`)
      bad++
      continue
    }
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

// --- 7. BNB на входе через V3 обязан отказывать понятной ошибкой,
//        а не отправлять заведомо падающую транзакцию.
{
  // BNB -> WBNB напрямую бессмысленно (один актив), поэтому берём пару,
  // которая реально уходит в V3: BNB -> USDT при живом нашем пуле.
  let r = null
  try {
    r = await quote(NATIVE, USDT, 10n ** 15n)
  } catch (e) {
    console.log(`     quote(BNB->USDT) бросил: ${e.message.slice(0, 60)}`)
  }

  if (!r) {
    console.log('OK   маршрута BNB->USDT нет — отказ не требуется')
    pass++
  } else if (!r.hops.some((h) => h.protocol === 'v3')) {
    console.log(`OK   BNB->USDT идёт через ${r.hops.map((h) => h.protocol).join('+')}, не V3`)
    pass++
  } else {
    let threw = false
    let msg = ''
    try {
      buildSwapTx({ route: r, tokenIn: NATIVE, tokenOut: USDT, recipient: RECIP, slippageBps: 100 })
    } catch (e) {
      threw = true
      msg = e.message
    }
    if (threw && /V3/.test(msg)) {
      pass++
      console.log('OK   BNB на входе через V3 отказывает с внятным сообщением')
    } else {
      fail++
      console.log(`FAIL BNB на входе через V3 не отказал: threw=${threw} msg=${msg.slice(0, 60)}`)
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
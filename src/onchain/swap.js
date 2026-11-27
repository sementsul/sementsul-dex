// Сборка транзакций обмена.
//
// Главная тонкость — нативный BNB. Пулы работают только с ERC-20, поэтому
// BNB приходится заворачивать в WBNB. У роутеров это решено по-разному:
//   V2 (наш и Pancake) умеет swapExactETHForTokens — одна транзакция;
//   V3 умеет только ERC-20, но есть multicall + unwrapWBNB.
// Поэтому для выхода в BNB через V3 собираем multicall из двух вызовов:
// обмен с получателем-роутером, затем разворачивание на пользователя.

import { SEL, encAddr, encUint } from './abi.js'
import { WBNB, V2_ROUTER, V3_ROUTER, PANCAKE_V2_ROUTER, PANCAKE_V3_ROUTER } from './config.js'
import { toPoolToken, isNative } from './pools.js'

export function routerFor(pool) {
  if (pool.protocol === 'v2') return pool.own ? V2_ROUTER : PANCAKE_V2_ROUTER
  return pool.own ? V3_ROUTER : PANCAKE_V3_ROUTER
}

// V3 путь: token(20) + fee(3) + token(20)
export function encodeV3Path(tokens, fees) {
  let out = tokens[0].replace(/^0x/i, '').toLowerCase()
  for (let i = 0; i < fees.length; i++) {
    out += fees[i].toString(16).padStart(6, '0')
    out += tokens[i + 1].replace(/^0x/i, '').toLowerCase()
  }
  return '0x' + out
}

// exactInputSingle нашего роутера: struct{bytes,address,uint256,uint256} + deadline
function encodeOwnExactInputSingle(pathHex, recipient, amountIn, minOut, deadline) {
  const p = pathHex.replace(/^0x/i, '')
  const pathBytes = p.length / 2
  let padded = p
  while (padded.length % 64 !== 0) padded += '0'
  const w = [
    encUint(64), // смещение на tuple
    encUint(deadline),
    encUint(128), // смещение на bytes внутри tuple
    encAddr(recipient),
    encUint(amountIn),
    encUint(minOut),
    encUint(pathBytes),
    padded,
  ]
  return SEL.exactInputSingleOwn + w.join('')
}

// exactInputSingle Pancake: 8 полей в структуре, дедлайн внутри неё
function encodePancakeExactInputSingle(tokenIn, tokenOut, fee, recipient, amountIn, minOut, deadline) {
  return (
    SEL.exactInputSinglePancake +
    encAddr(tokenIn) +
    encAddr(tokenOut) +
    encUint(fee) +
    encAddr(recipient) +
    encUint(deadline) +
    encUint(amountIn) +
    encUint(minOut) +
    encUint(0) // sqrtPriceLimitX96 = 0 -> без ограничения по цене
  )
}

function encodeMulticall(calls) {
  const n = calls.length
  const headSize = 32 * n
  const encoded = calls.map((c) => {
    const h = c.replace(/^0x/i, '')
    let padded = h
    while (padded.length % 64 !== 0) padded += '0'
    return encUint(h.length / 2) + padded
  })

  let acc = headSize
  const offsets = []
  for (let i = 0; i < n; i++) {
    offsets.push(encUint(acc))
    acc += encoded[i].length / 2
  }
  return SEL.multicall + encUint(32) + encUint(n) + offsets.join('') + encoded.join('')
}

// Смещение на динамический массив address[] равно размеру «головы», то есть
// 32 * (общее число параметров функции). Здесь я ошибался дважды: сначала
// ставил константу 64 для всех случаев, потом считал «слова до массива».
// Верно именно число параметров, потому что голова содержит по слову на
// каждый параметр, включая сам offset.
//   swapExactETHForTokens(minOut, path, to, deadline)              -> 4 * 32 = 128
//   swapExactTokensForETH(amountIn, minOut, path, to, deadline)    -> 5 * 32 = 160
//   swapExactTokensForTokens(amountIn, minOut, path, to, deadline) -> 5 * 32 = 160
// Проверено против viem: encodeFunctionData даёт ровно эти значения.
function headOffset(paramCount) {
  return encUint(32 * paramCount)
}

// Собирает список транзакций для обмена.
export function buildSwap({ route, tokenIn, tokenOut, recipient, amountIn, minOut, deadline }) {
  const txs = []
  const nativeIn = isNative(tokenIn)
  const nativeOut = isNative(tokenOut)
  const inAddr = toPoolToken(tokenIn)
  const outAddr = toPoolToken(tokenOut)

  // Маршрут из двух пулов пока не поддерживаем в сборке: там нужны
  // аккуратные approve между шагами. Если он выбран, честно сообщаем.
  if (route.length > 1) return { error: 'TWO_HOP_UNSUPPORTED' }

  const pool = route[0]
  const router = routerFor(pool)

  if (pool.protocol === 'v2') {
    const path = [inAddr, outAddr]
    const pathPart = encUint(path.length) + path.map(encAddr).join('')
    if (nativeIn) {
      txs.push({
        to: router,
        data: SEL.swapExactETHForTokens + encUint(minOut) + headOffset(4) + encAddr(recipient) + encUint(deadline) + pathPart,
        value: amountIn,
        label: 'Обмен BNB',
      })
    } else if (nativeOut) {
      txs.push({
        to: router,
        data: SEL.swapExactTokensForETH + encUint(amountIn) + encUint(minOut) + headOffset(5) + encAddr(recipient) + encUint(deadline) + pathPart,
        value: 0n,
        label: 'Обмен на BNB',
      })
    } else {
      txs.push({
        to: router,
        data: SEL.swapExactTokensForTokens + encUint(amountIn) + encUint(minOut) + headOffset(5) + encAddr(recipient) + encUint(deadline) + pathPart,
        value: 0n,
        label: 'Обмен',
      })
    }
    return { txs, needsApprove: !nativeIn }
  }

  // ---------- V3 ----------
  const pathHex = encodeV3Path([inAddr, outAddr], [pool.fee])
  const swapData = pool.own
    ? encodeOwnExactInputSingle(pathHex, recipient, amountIn, minOut, deadline)
    : encodePancakeExactInputSingle(inAddr, outAddr, pool.fee, recipient, amountIn, minOut, deadline)

  // Вход в BNB: сначала завернуть. Отдельными транзакциями, потому что
  // payer в роутере — это msg.sender, и он должен владеть WBNB.
  if (nativeIn) {
    txs.push({ to: WBNB, data: SEL.deposit, value: amountIn, label: 'Завернуть BNB' })
    txs.push({ to: WBNB, data: SEL.approve + encAddr(router) + encUint(amountIn), value: 0n, label: 'Разрешение WBNB' })
    txs.push({ to: router, data: swapData, value: 0n, label: 'Обмен' })
    return { txs, needsApprove: false }
  }

  if (nativeOut) {
    // Обмен с получателем-роутер, затем разворачивание WBNB в BNB.
    const inner = pool.own
      ? encodeOwnExactInputSingle(pathHex, router, amountIn, minOut, deadline)
      : encodePancakeExactInputSingle(inAddr, outAddr, pool.fee, router, amountIn, minOut, deadline)
    const unwrap = SEL.unwrapWBNB + encUint(minOut) + encAddr(recipient)
    txs.push({ to: router, data: encodeMulticall([inner, unwrap]), value: 0n, label: 'Обмен на BNB' })
    return { txs, needsApprove: true }
  }

  txs.push({ to: router, data: swapData, value: 0n, label: 'Обмен' })
  return { txs, needsApprove: true }
}

export function buildApprove(token, spender, amount) {
  return { to: token, data: SEL.approve + encAddr(spender) + encUint(amount), value: 0n, label: 'Разрешение' }
}
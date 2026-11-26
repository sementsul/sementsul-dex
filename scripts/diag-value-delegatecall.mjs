// Ключевая проверка: доходит ли msg.value до wrapBNB, когда он вызывается
// внутри multicall через delegatecall.
//
// В delegatecall контекст (включая msg.value) наследуется от ВЫЗЫВАЮЩЕГО.
// multicall объявлен payable, значит msg.value в нём = value транзакции.
// При delegatecall на самого себя msg.value должен сохраниться. Проверяем
// это на практике: вызываем только wrapBNB через multicall и смотрим,
// появился ли WBNB на роутере.

import {
  createPublicClient, http, toHex, formatUnits, parseAbi, keccak256,
  encodeAbiParameters, parseAbiParameters,
} from 'viem'
import { bsc } from 'viem/chains'
import deployments from '../src/contracts/deployments.js'
import { SEL, encUint } from '../src/lib/abi.js'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const WBNB = deployments.wbnb
const ROUTER = deployments.v3Router
const ME = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const amount = 100_000_000_000_000_000n

const erc = parseAbi(['function balanceOf(address) view returns (uint256)'])

// multicall([wrapBNB(amount)])
const wrapCall = SEL.wrapBNB + encUint(amount)
function multicallData(calls) {
  const n = calls.length
  let offsets = ''
  let body = ''
  let running = n * 32
  for (const c of calls) {
    offsets += running.toString(16).padStart(64, '0')
    const bytes = c.replace(/^0x/, '')
    const len = bytes.length / 2
    const padded = bytes.padEnd(Math.ceil(len / 32) * 64, '0')
    body += len.toString(16).padStart(64, '0') + padded
    running += 32 + padded.length / 2
  }
  return SEL.multicall + encUint(0x20) + encUint(n) + offsets + body
}

const data = multicallData([wrapCall])
console.log('multicall([wrapBNB]) calldata:', (data.length - 2) / 2, 'байт')
console.log('')

// Проверяем баланс WBNB роутера ДО и ПОСЛЕ через eth_call с подменой
// хранилища: записываем результат вызова, затем читаем баланс в том же
// «состоянии» невозможно без трейсинга. Поэтому идём другим путём —
// смотрим, вернёт ли вызов ошибку.

try {
  await client.call({
    to: ROUTER,
    data,
    account: ME,
    value: amount,
    stateOverride: [{ address: ME, balance: toHex(10n * 10n ** 18n, { size: 32 }) }],
  })
  console.log('multicall([wrapBNB]) с value: ПРОХОДИТ')
  console.log('  => msg.value доходит до wrapBNB через delegatecall')
} catch (e) {
  console.log('multicall([wrapBNB]) с value: откат —', (e.shortMessage ?? e.message).slice(0, 140))
  console.log('  => msg.value НЕ доходит, нужен другой способ заворачивания')
}

// Для сравнения — прямой вызов wrapBNB.
try {
  await client.call({
    to: ROUTER, data: wrapCall, account: ME, value: amount,
    stateOverride: [{ address: ME, balance: toHex(10n * 10n ** 18n, { size: 32 }) }],
  })
  console.log('прямой wrapBNB с value: ПРОХОДИТ')
} catch (e) {
  console.log('прямой wrapBNB с value: откат —', (e.shortMessage ?? e.message).slice(0, 140))
}
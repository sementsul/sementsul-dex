// Проверка: какие селекторы реально есть в задеплоенном V3-роутере.
//
// Фронтенд (src/lib/abi.js) кодирует exactInputSingle с сигнатурой Uniswap на
// 8 полей, а наш контракт объявляет struct ExactInputParams из 4 полей (bytes
// path, recipient, amountIn, amountOutMinimum). Селекторы у таких сигнатур
// разные, значит вызов уйдёт в никуда. Проверяем по байткоду, а не по ABI:
// ABI мог быть собран из другого источника.

import { createPublicClient, http, keccak256, toHex, slice } from 'viem'
import { bsc } from 'viem/chains'
import deployments from '../src/contracts/deployments.js'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })

const sigs = {
  'ours: exactInputSingle((bytes,address,uint256,uint256),uint256)':
    'exactInputSingle((bytes,address,uint256,uint256),uint256)',
  'uniswap 8 полей: exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))':
    'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  'ours: exactInput((bytes,address,uint256,uint256),uint256)':
    'exactInput((bytes,address,uint256,uint256),uint256)',
  'uniswap: exactInput((bytes,address,uint256,uint256),uint256)':
    'exactInput((bytes,address,uint256,uint256),uint256)',
  'ours: exactOutputSingle((bytes,address,uint256,uint256),uint256)':
    'exactOutputSingle((bytes,address,uint256,uint256),uint256)',
  'multicall(bytes[])': 'multicall(bytes[])',
  'refundBNB()': 'refundBNB()',
  'refundETH()': 'refundETH()',
  'unwrapWBNB(uint256,address)': 'unwrapWBNB(uint256,address)',
  'unwrapWETH9(uint256,address)': 'unwrapWETH9(uint256,address)',
  'wrapBNB(uint256)': 'wrapBNB(uint256)',
}

const code = await client.getBytecode({ address: deployments.v3Router })
console.log('роутер:', deployments.v3Router)
console.log('байткод:', (code.length - 2) / 2, 'байт')
console.log('')

const sel = (s) => keccak256(toHex(s)).slice(0, 10)
for (const [label, sig] of Object.entries(sigs)) {
  const s = sel(sig)
  const present = code.toLowerCase().includes(s.slice(2).toLowerCase())
  console.log((present ? '  ЕСТЬ ' : '  нет   ') + s + '  ' + label)
}
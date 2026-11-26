// Сравнение multicall: как кодирует viem и как кодирует фронтенд.

import { encodeFunctionData } from 'viem'
import artifacts from '../src/contracts/artifacts.json' with { type: 'json' }

const abi = artifacts.SementsulV3Router.abi

const inner = '0xea7ec9c4' + '00'.repeat(136) // заглушка
const refund = '0xf37050da'

const ref = encodeFunctionData({ abi, functionName: 'multicall', args: [[inner, refund]] })

console.log('эталон (viem):', (ref.length - 2) / 2, 'байт')
const words = ref.slice(10).match(/.{64}/g) ?? []
words.forEach((w, i) => console.log(`  [${i}] 0x${w}`))

// Теперь то, что делает multicallData в quote.js
const { SEL } = await import('../src/lib/abi.js')
const encUint = (v) => BigInt(v).toString(16).padStart(64, '0')

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

const mine = multicallData([inner, refund])
console.log('')
console.log('фронтенд:      ', (mine.length - 2) / 2, 'байт')
const w2 = mine.slice(10).match(/.{64}/g) ?? []
w2.forEach((w, i) => console.log(`  [${i}] 0x${w}`))

console.log('')
console.log('совпадают:', ref === mine)
console.log('')
console.log('Смещения должны считаться от начала МАССИВА (после слова длины),')
console.log('а не от начала calldata. У viem первый элемент = n*32 =', 2 * 32)
console.log('У фронтенда первый элемент =', parseInt(w2[2], 16), '(это n*32, совпадает)')
console.log('Второй элемент: viem =', parseInt(words[3], 16), '| фронтенд =', parseInt(w2[3], 16))
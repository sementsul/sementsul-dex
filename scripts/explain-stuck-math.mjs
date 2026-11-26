// Проверяем корень: Uniswap v3-core компилируется 0.7.6, где нет проверки
// переполнения. Наш контракт — 0.8.24, где есть.

import fs from 'node:fs'

const src = fs.readFileSync('contracts/SementsulV3.sol', 'utf8')
const pragma = src.match(/pragma solidity ([^;]+);/)
console.log('pragma нашего пула:', pragma[1])

// Воспроизводим арифметику вручную.
const G = 170141183460469231731687303715884n // global на момент минта
const L = 100000000000000000000n
const Q128 = 2n ** 128n

// После минта в свежий диапазон сохранено last = global.
const lastAtMint = G

// На очередном collect: inside = global_now - lower.outside - upper.outside.
// lower.outside был выставлен в global на минте, upper.outside остался 0.
function inside(globalNow) {
  const below = G // lower.feeGrowthOutside
  const above = 0n // upper.feeGrowthOutside
  return globalNow - below - above
}

console.log('')
console.log('--- если комиссия выросла всего на 10% после минта ---')
const globalNow = (G * 11n) / 10n
const insideNow = inside(globalNow)
console.log('inside0      =', insideNow)
console.log('last0        =', lastAtMint)
console.log('inside - last=', insideNow - lastAtMint, ' (отрицательное!)')

console.log('')
console.log('--- сколько нужно, чтобы не упасть ---')
console.log('нужно global_now >= 2 * global_mint =', G * 2n)
console.log('то есть комиссия должна вырасти вдвое, прежде чем collect перестанет падать')
console.log('')
console.log('ВЫВОД: позиция не «заперта до лучших времён» —')
console.log('       она откроется, когда глобальная комиссия удвоится.')
console.log('       Но это может быть очень нескоро, и burn всё это время тоже падает.')
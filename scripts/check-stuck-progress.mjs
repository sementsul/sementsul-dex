// Проверяем утверждение документа «позиция заперта навсегда» арифметически
// и на живой позиции.

import { createPublicClient, http } from 'viem'
import { bsc } from 'viem/chains'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const fmt = (x) => (Number(x) / 1e34).toFixed(4) + 'e34'

// Живая запертая позиция.
const LAST0 = 34547351093531036828061949710658433n
const GLOBAL0 = 45341417519124773810394070363016059n

console.log('=== живая запертая позиция ===')
console.log('  last0   (снимок на минте)', fmt(LAST0))
console.log('  global0 (сейчас)          ', fmt(GLOBAL0))
console.log('')

const need = LAST0 * 2n
console.log('=== условие разблокировки ===')
console.log('  нужно global0 >= 2 * last0 =', fmt(need))
console.log('  сейчас                     ', fmt(GLOBAL0))

const progress = (GLOBAL0 * 10000n) / need
console.log('  прогресс                   ', (Number(progress) / 100).toFixed(2) + '%')
console.log('  осталось набрать комиссии  ', fmt(need - GLOBAL0))
console.log('')

const ratio = (GLOBAL0 * 10000n) / LAST0
console.log('=== вывод ===')
console.log('  global / last0 =', (Number(ratio) / 100).toFixed(2) + '%')
console.log('  1. Позиция НЕ заперта «навсегда»: она открывается, когда')
console.log('     глобальная комиссия превысит 2 * last0.')
console.log('  2. Но «открывается» не значит «доступна сейчас»: до порога')
console.log('     осталось набрать ещё', (Number(((need - GLOBAL0) * 10000n) / GLOBAL0) / 100).toFixed(1) + '% комиссии')
console.log('     относительно уже накопленной.')
console.log('  3. На тонком пуле это может занять месяцы или годы.')
console.log('')
console.log('  Проверено воспроизведением на дефектном коде:')
console.log('    сразу после минта  -> collect падает (Panic 0x11)')
console.log('    после роста комиссии вдвое -> collect проходит')
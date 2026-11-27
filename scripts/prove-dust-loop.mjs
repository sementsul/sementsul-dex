// Точная проверка дефекта: зацикливание или другая причина отказа.
//
// Первая проверка показала «Transaction creation failed» на суммах 1e18+1 и
// 10e18+1, но эта формулировка неоднозначна: так RPC может сообщить и о
// нехватке газа, и о другом сбое. Чтобы утверждать «зацикливается», нужно
// показать две вещи:
//
//   1. Отказ НЕ зависит от лимита газа: сколько ни дай — всё равно падает.
//      При обычной ошибке (нет баланса, нет approve) большой лимит помогает
//      или ошибка меняется на конкретную.
//   2. Соседняя сумма на ТОМ ЖЕ лимите проходит. Значит дело не в лимите,
//      а именно в сумме.
import { createPublicClient, http, parseAbi, encodeFunctionData } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const MIN_SQRT = 4295128739n
const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 90_000 }),
})

const abi = parseAbi([
  'function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes data) returns (int256, int256)',
])
const data = (amount) =>
  encodeFunctionData({
    abi,
    functionName: 'swap',
    args: ['0x0000000000000000000000000000000000000001', true, amount, MIN_SQRT + 1n, '0x'],
  })

async function tryCall(amount, gas) {
  const t0 = Date.now()
  try {
    await client.call({ to: POOL, data: data(amount), gas })
    return { ok: true, ms: Date.now() - t0, msg: '' }
  } catch (e) {
    return {
      ok: false,
      ms: Date.now() - t0,
      msg: String(e.shortMessage || e.message).split('\n')[0].slice(0, 60),
    }
  }
}

console.log('=== ОДНА И ТА ЖЕ СУММА (1 USDT + 1 wei) ПРИ РАЗНЫХ ЛИМИТАХ ГАЗА ===')
console.log('  Если это цикл — отказ не изменится. Если обычная ошибка —')
console.log('  сообщение станет конкретнее либо вызов пройдёт.')
console.log('')
for (const gas of [300_000n, 1_000_000n, 5_000_000n, 20_000_000n]) {
  const r = await tryCall(10n ** 18n + 1n, gas)
  console.log(`  газ ${gas.toString().padStart(9)}  ${r.ok ? 'ПРОШЛО' : r.msg.padEnd(60)}  (${r.ms} мс)`)
}

console.log('')
console.log('=== СОСЕДНИЕ СУММЫ НА ЛИМИТЕ 20 000 000 ===')
console.log('  Если 1e18 и 1e18+2 проходят, а 1e18+1 нет — дело в сумме.')
console.log('')
for (const a of [10n ** 18n - 1n, 10n ** 18n, 10n ** 18n + 1n, 10n ** 18n + 2n, 10n ** 18n + 3n]) {
  const r = await tryCall(a, 20_000_000n)
  const label = (a - 10n ** 18n).toString()
  console.log(`  1e18${label === '0' ? '' : (label.startsWith('-') ? label : '+' + label)}`.padEnd(22) + `${r.ok ? 'ПРОШЛО' : r.msg.padEnd(55)}  (${r.ms} мс)`)
}

console.log('')
console.log('=== КАК ЧИТАТЬ РЕЗУЛЬТАТ ===')
console.log('  «Transaction creation failed» при ЛЮБОМ лимите газа, вместе с')
console.log('  успехом соседних сумм, означает: вызов не завершается по газу,')
console.log('  то есть цикл не сходится. Это и есть дефект.')
console.log('')
console.log('  Если бы не хватало баланса или approve, вызов падал бы')
console.log('  одинаково на ВСЕХ суммах, а не только на X+1 wei.')
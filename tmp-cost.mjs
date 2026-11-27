// Сколько реально стоит положить сайт в BSC при текущей цене газа.
const GAS_PRICE = 50_000_000n // 0.05 gwei
const BNB_USD = 563.5

const usd = (gas) => (Number(gas * GAS_PRICE) / 1e18) * BNB_USD
const bnb = (gas) => Number(gas * GAS_PRICE) / 1e18

console.log('=== условия ===')
console.log('  газ:', Number(GAS_PRICE) / 1e9, 'gwei')
console.log('  BNB: $' + BNB_USD)
console.log('  лимит газа в блоке: 80 000 000')
console.log('')

for (const kb of [12, 40, 60]) {
  const bytes = BigInt(kb * 1024)
  console.log(`=== сайт ${kb} KB ===`)

  // SSTORE: 20000 газа за 32-байтное слово
  const gSstore = (bytes / 32n) * 20000n
  console.log(`  SSTORE  (625/байт): ${(Number(gSstore) / 1e6).toFixed(1)}M = $${usd(gSstore).toFixed(2)}`)

  // SSTORE2: код как данные, 200/байт + 32000 за деплой контракта
  const nContracts = Math.ceil((kb * 1024) / 24000)
  const gCode = bytes * 200n + BigInt(nContracts) * 32000n
  console.log(`  код     (200/байт): ${(Number(gCode) / 1e6).toFixed(2)}M = $${usd(gCode).toFixed(3)}  (${nContracts} контрактов)`)

  // calldata: 16 газа за ненулевой байт
  const gData = bytes * 16n + 21000n
  console.log(`  calldata(16/байт): ${(Number(gData) / 1e6).toFixed(2)}M = $${usd(gData).toFixed(3)}`)
  console.log('')
}

console.log('=== что можно на 4 USDT ===')
const budget = 4 / BNB_USD // в BNB
console.log('  4 USDT =', budget.toFixed(6), 'BNB')
const gas4 = (budget * 1e18) / Number(GAS_PRICE)
console.log('  =', Math.round(gas4).toLocaleString('en-US'), 'газа')
console.log('  calldata:', ((gas4 - 21000) / 16 / 1024).toFixed(0), 'KB')
console.log('  код:', ((gas4 - 32000) / 200 / 1024).toFixed(0), 'KB')
console.log('')
console.log('=== ВАЖНО ===')
console.log('  газ в BSC платится ТОЛЬКО в BNB.')
console.log('  USDT (BEP-20) — это токен, он не годится для комиссии.')
console.log('  MetaMask не даёт платить газ токеном: он продаёт BNB за токен')
console.log('  через встроенный swap и уже потом платит газ.')
console.log('  Для ЭТОГО кошелька такой swap сделать некому: ключ у нас,')
console.log('  но USDT лежит мёртвым грузом без BNB на первую транзакцию.')
// Сверка наших событий создания пулов с эталонами Uniswap.
//
// Индексаторы (GeckoTerminal, DexScreener, боты-снайперы) ищут пулы не «по
// названию», а по topic0 — keccak256 от полной сигнатуры события. Если
// сигнатура отличается хотя бы одним полем, topic0 другой, и наш пул для них
// не существует.
//
// ВАЖНО: сигнатуры берутся из СКОМПИЛИРОВАННОГО ABI, а не из строки в этом
// файле. Раньше здесь была зашита сигнатура — и после исправления контракта
// скрипт продолжал рапортовать «отличается», потому что сравнивал сам с собой.
// Проверка, которая не читает проверяемое, ничего не проверяет.

import { keccak256, toHex } from 'viem'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))

function abiOf(name) {
  const a = artifacts[name]
  if (!a) throw new Error(`нет артефакта ${name} — сначала npm run compile`)
  return a.abi
}

// Собираем каноническую сигнатуру события из ABI.
function eventSig(abi, name) {
  const ev = abi.find((x) => x.type === 'event' && x.name === name)
  if (!ev) throw new Error(`в ABI нет события ${name}`)
  return `${name}(${ev.inputs.map((i) => i.type).join(',')})`
}

// Собираем сигнатуру функции из ABI.
function fnSig(abi, name) {
  const fn = abi.find((x) => x.type === 'function' && x.name === name)
  if (!fn) return null
  return `${name}(${fn.inputs.map((i) => i.type).join(',')})`
}

const reference = {
  pairCreated: 'PairCreated(address,address,address,uint256)',
  poolCreated: 'PoolCreated(address,address,uint24,int24,address)',
  getPool: 'getPool(address,address,uint24)',
}

const topic = (sig) => keccak256(toHex(sig))

console.log('=== сигнатуры, прочитанные из ABI ===')

const v2Abi = abiOf('SementsulFactory')
const v3Abi = abiOf('SementsulV3Factory')

const ourPairCreated = eventSig(v2Abi, 'PairCreated')
const ourPoolCreated = eventSig(v3Abi, 'PoolCreated')

console.log('наш V2 PairCreated:', ourPairCreated)
console.log('наш V3 PoolCreated:', ourPoolCreated)
console.log('наш V3 getPool:    ', fnSig(v3Abi, 'getPool') ?? 'ОТСУТСТВУЕТ')

console.log()
console.log('=== сверка topic0 ===')

const v2Ok = topic(ourPairCreated) === topic(reference.pairCreated)
const v3Ok = topic(ourPoolCreated) === topic(reference.poolCreated)

console.log(
  'V2 PairCreated:',
  v2Ok ? 'СОВПАДАЕТ — боты увидят пары автоматически' : 'ОТЛИЧАЕТСЯ — боты пары не увидят'
)
console.log(
  'V3 PoolCreated:',
  v3Ok ? 'СОВПАДАЕТ — индексаторы увидят пулы' : 'ОТЛИЧАЕТСЯ — V3-пулы для индексаторов не существуют'
)

// getPool должен не просто существовать, а иметь ровно ту сигнатуру, которую
// зовут индексаторы: с тиром комиссии третьим аргументом.
const ourGetPool = fnSig(v3Abi, 'getPool')
const getPoolOk = ourGetPool === reference.getPool
console.log(
  'V3 getPool:    ',
  getPoolOk ? 'СОВПАДАЕТ' : `ОТЛИЧАЕТСЯ (${ourGetPool ?? 'нет функции'})`
)

if (getPoolOk) {
  console.log('  селектор:', keccak256(toHex(reference.getPool)).slice(0, 10))
}

console.log()
if (v2Ok && v3Ok && getPoolOk) {
  console.log('ИТОГ: все три совпадают с эталоном Uniswap.')
} else {
  console.log('ИТОГ: есть расхождения — см. выше.')
  process.exitCode = 1
}
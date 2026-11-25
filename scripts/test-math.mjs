// Проверка математики V3.
//
// Эталоны берутся из двух независимых источников:
//   1) известные константы Uniswap V3 (границы диапазона), они проверены
//      годами работы протокола;
//   2) точный целочисленный расчёт isqrt с масштабом 2^96 — он не повторяет
//      алгоритм контракта (тот считает произведением констант), поэтому
//      сравнение честное.
//
// Без этой проверки ошибка в тиках не видна: пул бы работал, но цена ехала
// бы не туда, и заметить это можно было бы только по потерянным деньгам.

import { VM } from '@ethereumjs/vm'
import { Common, Chain, Hardfork } from '@ethereumjs/common'
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { keccak256 } from 'ethereum-cryptography/keccak.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOLC_PATH = process.env.SOLC_PATH ?? join(ROOT, '..', '_soltest', 'node_modules', 'solc', 'index.js')
const solc = (await import(pathToFileURL(SOLC_PATH).href)).default

let pass = 0
let fail = 0
const failures = []
function check(label, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  OK   ${label}${extra ? ' — ' + extra : ''}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  FAIL ${label}${extra ? ' — ' + extra : ''}`)
  }
}

const HARNESS = `// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;
import 'contracts/SementsulV3Math.sol';

contract MathHarness {
    function sqrtRatioAtTick(int24 tick) external pure returns (uint160) { return TickMath.getSqrtRatioAtTick(tick); }
    function tickAtSqrtRatio(uint160 s) external pure returns (int24) { return TickMath.getTickAtSqrtRatio(s); }
    function mulDiv(uint256 a, uint256 b, uint256 d) external pure returns (uint256) { return FullMath.mulDiv(a, b, d); }
    function mulDivUp(uint256 a, uint256 b, uint256 d) external pure returns (uint256) { return FullMath.mulDivRoundingUp(a, b, d); }
    function amount0Delta(uint160 a, uint160 b, uint128 l, bool up) external pure returns (uint256) { return SqrtPriceMath.getAmount0Delta(a, b, l, up); }
    function amount1Delta(uint160 a, uint160 b, uint128 l, bool up) external pure returns (uint256) { return SqrtPriceMath.getAmount1Delta(a, b, l, up); }
    function swapStep(uint160 cur, uint160 target, uint128 l, int256 remaining, uint24 fee)
        external pure returns (uint160 next, uint256 amountIn, uint256 amountOut, uint256 feeAmount)
    { return SwapMath.computeSwapStep(cur, target, l, remaining, fee); }
}`

const out = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: 'Solidity',
      sources: {
        'contracts/SementsulV3Math.sol': { content: readFileSync(join(ROOT, 'contracts', 'SementsulV3Math.sol'), 'utf8') },
        'MathHarness.sol': { content: HARNESS },
      },
      settings: {
        optimizer: { enabled: true, runs: 200 },
        evmVersion: 'shanghai',
        outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
      },
    })
  )
)
const errs = (out.errors ?? []).filter((e) => e.severity === 'error')
if (errs.length) {
  console.error(errs[0].formattedMessage)
  process.exit(1)
}

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai })
const vm = await VM.create({ common })
const BLOCK = {
  header: {
    number: 1n,
    timestamp: 1700000000n,
    coinbase: Address.fromString('0x' + '00'.repeat(20)),
    difficulty: 0n,
    gasLimit: 30_000_000n,
    baseFeePerGas: 0n,
  },
}
const OWNER = '0x' + '11'.repeat(20)
await vm.stateManager.putAccount(Address.fromString(OWNER), new Account(0n, 10n ** 23n))

const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0')
const intWord = (n) => {
  let v = BigInt(n)
  if (v < 0n) v = (1n << 256n) + v
  return v.toString(16).padStart(64, '0')
}
const sel = (sig) => Buffer.from(keccak256(Buffer.from(sig, 'utf8'))).subarray(0, 4).toString('hex')

async function call(to, data) {
  const res = await vm.evm.runCall({
    to: to ? Address.fromString(to) : undefined,
    caller: Address.fromString(OWNER),
    origin: Address.fromString(OWNER),
    data: hexToBytes(data),
    gasLimit: 25_000_000n,
    value: 0n,
    block: BLOCK,
  })
  return {
    success: !res.execResult.exceptionError,
    error: res.execResult.exceptionError?.error,
    ret: bytesToHex(res.execResult.returnValue),
    created: res.createdAddress ? bytesToHex(res.createdAddress.toBytes()) : null,
  }
}

const want = BigInt('0x' + (await Promise.resolve(1)).toString(16)) // заглушка, не используется

const d = await call(null, '0x' + out.contracts['MathHarness.sol'].MathHarness.evm.bytecode.object)
const harness = d.created
if (!harness) {
  console.error('харнесс не развернулся')
  process.exit(1)
}

const words = (ret) => {
  const hex = ret.slice(2)
  const arr = []
  for (let i = 0; i < hex.length; i += 64) arr.push(hex.slice(i, i + 64))
  return arr
}

const TWO96 = 1n << 96n

function isqrt(n) {
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}

// sqrt(1.0001^tick) * 2^96 с точностью до 1 единицы.
// Масштабируем на 2^192, чтобы isqrt не потерял значащие биты:
//   sqrt(10001^n/10000^n) = sqrt(10001^n * 10000^n) / 10000^n
//   результат = isqrt(10001^n * 10000^n * 2^192) / 10000^n
function exactSqrtRatio(tick) {
  const n = BigInt(Math.abs(tick))
  if (n === 0n) return TWO96
  const p = (10001n * 10000n) ** n // ~4n знаков на тик, для |tick|<=3000 приемлемо
  const scaled = p << 192n
  const root = isqrt(scaled)
  return tick > 0 ? root / 10000n ** n : root / 10001n ** n
}

// ---------- TickMath ----------

console.log('=== TickMath: известные константы Uniswap V3 ===')
{
  const r = await call(harness, '0x' + sel('sqrtRatioAtTick(int24)') + intWord(0))
  const got = BigInt('0x' + words(r.ret)[0])
  check('sqrtRatio(0) = 2^96', got === TWO96, `${got}`)
}
{
  const r = await call(harness, '0x' + sel('sqrtRatioAtTick(int24)') + intWord(887272))
  const got = BigInt('0x' + words(r.ret)[0])
  const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n
  check('sqrtRatio(MAX_TICK) = MAX_SQRT_RATIO', got === MAX_SQRT_RATIO, `${got}`)
}
{
  const r = await call(harness, '0x' + sel('sqrtRatioAtTick(int24)') + intWord(-887272))
  const got = BigInt('0x' + words(r.ret)[0])
  check('sqrtRatio(MIN_TICK) = MIN_SQRT_RATIO', got === 4295128739n, `${got}`)
}

console.log('\n=== TickMath: сверка с точным целочисленным эталоном ===')
{
  let bad = 0
  const details = []
  for (const t of [-3000, -2000, -1000, -500, -100, -37, -1, 0, 1, 37, 100, 500, 1000, 2000, 3000]) {
    const r = await call(harness, '0x' + sel('sqrtRatioAtTick(int24)') + intWord(t))
    if (!r.success) {
      bad++
      details.push(`${t}: ${r.error}`)
      continue
    }
    const got = BigInt('0x' + words(r.ret)[0])
    const ref = exactSqrtRatio(t)
    const diff = got > ref ? got - ref : ref - got
    // Допуск 2: округление вверх в контракте и вниз в эталоне.
    if (diff > 2n) {
      bad++
      details.push(`${t}: ${got} vs ${ref} (${diff})`)
    }
  }
  check('все тики совпадают с эталоном', bad === 0, details.slice(0, 3).join('; '))
}

console.log('\n=== TickMath: свойства ===')
{
  let mono = true
  let prev = 0n
  for (let t = -2000; t <= 2000; t += 50) {
    const r = await call(harness, '0x' + sel('sqrtRatioAtTick(int24)') + intWord(t))
    const v = BigInt('0x' + words(r.ret)[0])
    if (t > -2000 && v <= prev) mono = false
    prev = v
  }
  check('sqrtRatio строго растёт по тику', mono)
}
{
  let bad = 0
  const details = []
  // MAX_TICK даёт ровно MAX_SQRT_RATIO, а getTickAtSqrtRatio принимает только
  // строго меньше — это граница диапазона, а не рабочий тик. Поэтому верхняя
  // проверка идёт по MAX_TICK-1.
  for (const t of [-887272, -100000, -10000, -1000, -137, -1, 0, 1, 137, 1000, 10000, 100000, 887271]) {
    const r1 = await call(harness, '0x' + sel('sqrtRatioAtTick(int24)') + intWord(t))
    if (!r1.success) {
      bad++
      details.push(`${t}: ${r1.error}`)
      continue
    }
    const sqrtP = words(r1.ret)[0]
    const r2 = await call(harness, '0x' + sel('tickAtSqrtRatio(uint160)') + sqrtP)
    if (!r2.success) {
      bad++
      details.push(`${t}: обратно ${r2.error}`)
      continue
    }
    const back = BigInt('0x' + words(r2.ret)[0])
    const signed = back >= 1n << 255n ? back - (1n << 256n) : back
    if (Number(signed) !== t) {
      bad++
      details.push(`${t} -> ${signed}`)
    }
  }
  check('tick <-> sqrtPrice обратимы', bad === 0, details.slice(0, 3).join('; '))
}
{
  // Граница диапазона не принимается на вход — так и задумано.
  const r = await call(harness, '0x' + sel('tickAtSqrtRatio(uint160)') + uintWord(1461446703485210103287273052203988822378723970342n))
  check('MAX_SQRT_RATIO не принимается (граница исключена)', !r.success, r.error ?? 'нет ошибки')
}
{
  const r1 = await call(harness, '0x' + sel('sqrtRatioAtTick(int24)') + intWord(887273))
  check('тик выше MAX отклонён', !r1.success, r1.error ?? 'нет ошибки')
  const r2 = await call(harness, '0x' + sel('sqrtRatioAtTick(int24)') + intWord(-887273))
  check('тик ниже MIN отклонён', !r2.success, r2.error ?? 'нет ошибки')
}

// ---------- FullMath ----------

console.log('\n=== FullMath ===')
{
  const a = 10n ** 30n
  const b = 3n * 10n ** 20n
  const dnv = 7n * 10n ** 15n
  const r = await call(harness, '0x' + sel('mulDiv(uint256,uint256,uint256)') + uintWord(a) + uintWord(b) + uintWord(dnv))
  check('mulDiv без переполнения (a*b > 2^256)', BigInt('0x' + words(r.ret)[0]) === (a * b) / dnv)
}
{
  // Произведение занимает всю ширину 512 бит, результат помещается в 256.
  const a = 2n ** 200n
  const b = 2n ** 200n
  const dnv = 2n ** 200n
  const r = await call(harness, '0x' + sel('mulDiv(uint256,uint256,uint256)') + uintWord(a) + uintWord(b) + uintWord(dnv))
  check('mulDiv при 400-битном произведении', r.success && BigInt('0x' + words(r.ret)[0]) === (a * b) / dnv, `${BigInt('0x' + (words(r.ret)[0] ?? '0'))}`)
}
{
  const r = await call(harness, '0x' + sel('mulDiv(uint256,uint256,uint256)') + uintWord(10n) + uintWord(10n) + uintWord(0n))
  check('деление на ноль отклонено', !r.success, r.error ?? 'нет ошибки')
}
{
  const a = 7n
  const b = 3n
  const dnv = 2n
  const r = await call(harness, '0x' + sel('mulDivUp(uint256,uint256,uint256)') + uintWord(a) + uintWord(b) + uintWord(dnv))
  check('mulDivRoundingUp округляет вверх', BigInt('0x' + words(r.ret)[0]) === (a * b + dnv - 1n) / dnv)
}
{
  // Остаток ровно ноль: округление вверх не должно прибавлять единицу.
  const r = await call(harness, '0x' + sel('mulDivUp(uint256,uint256,uint256)') + uintWord(10n) + uintWord(2n) + uintWord(5n))
  check('mulDivRoundingUp без остатка не прибавляет', BigInt('0x' + words(r.ret)[0]) === 4n)
}

// ---------- SqrtPriceMath ----------

console.log('\n=== SqrtPriceMath ===')
{
  const sqrtA = BigInt('0x1000000000000000000000000') // tick 0
  const sqrtB = 2n * sqrtA
  const L = 10n ** 18n
  const r0 = await call(harness, '0x' + sel('amount0Delta(uint160,uint160,uint128,bool)') + uintWord(sqrtA) + uintWord(sqrtB) + uintWord(L) + uintWord(1))
  const r1 = await call(harness, '0x' + sel('amount1Delta(uint160,uint160,uint128,bool)') + uintWord(sqrtA) + uintWord(sqrtB) + uintWord(L) + uintWord(1))
  const a0 = BigInt('0x' + words(r0.ret)[0])
  const a1 = BigInt('0x' + words(r1.ret)[0])

  // Инвариант Uniswap: L = a0*a1 / (a1/sqrtB - a0/sqrtA)... проверяем проще —
  // формулу a0 = L*(1/sqrtA - 1/sqrtB) с точностью до округления.
  const expectedA0 = (L * (sqrtB - sqrtA) * TWO96) / (sqrtB * sqrtA)
  const diff = a0 > expectedA0 ? a0 - expectedA0 : expectedA0 - a0
  check('amount0Delta сходится с формулой', diff <= 2n, `${a0} vs ${expectedA0}`)
  check('amount1Delta = L*(sqrtB-sqrtA)/2^96', a1 === (L * (sqrtB - sqrtA)) / TWO96, `${a1}`)
}
{
  const sqrtA = BigInt('0x1000000000000000000000000')
  const sqrtB = 2n * sqrtA
  const L = 10n ** 18n
  const fwd = await call(harness, '0x' + sel('amount0Delta(uint160,uint160,uint128,bool)') + uintWord(sqrtA) + uintWord(sqrtB) + uintWord(L) + uintWord(0))
  const rev = await call(harness, '0x' + sel('amount0Delta(uint160,uint160,uint128,bool)') + uintWord(sqrtB) + uintWord(sqrtA) + uintWord(L) + uintWord(0))
  check('amount0Delta симметричен по порядку цен', fwd.ret === rev.ret)
}
{
  const sqrtA = BigInt('0x1000000000000000000000000')
  const sqrtB = 2n * sqrtA
  const L = 10n ** 18n
  const r0 = await call(harness, '0x' + sel('amount0Delta(uint160,uint160,uint128,bool)') + uintWord(sqrtA) + uintWord(sqrtB) + uintWord(L) + uintWord(0))
  const r0b = await call(harness, '0x' + sel('amount0Delta(uint160,uint160,uint128,bool)') + uintWord(sqrtA) + uintWord(sqrtB) + uintWord(2n * L) + uintWord(0))
  const a = BigInt('0x' + words(r0.ret)[0])
  const b = BigInt('0x' + words(r0b.ret)[0])
  check('amount0Delta линеен по ликвидности', b === a * 2n || b === a * 2n + 1n, `${a} -> ${b}`)
}

// ---------- SwapMath ----------

console.log('\n=== SwapMath ===')
{
  const cur = BigInt('0x1000000000000000000000000') // tick 0
  const target = cur / 2n
  const L = 10n ** 18n
  const amountIn = 10n ** 15n
  const r = await call(harness, '0x' + sel('swapStep(uint160,uint160,uint128,int256,uint24)') + uintWord(cur) + uintWord(target) + uintWord(L) + uintWord(amountIn) + uintWord(500))
  check('swapStep выполнился', r.success, r.error ?? '')
  const w = words(r.ret)
  const next = BigInt('0x' + w[0])
  const ain = BigInt('0x' + w[1])
  const aout = BigInt('0x' + w[2])
  const feeAmt = BigInt('0x' + w[3])

  check('цена сдвинулась вниз', next < cur && next > target, `next=${next}`)
  check('вход не больше заданного', ain <= amountIn, `${ain} из ${amountIn}`)
  // Главная проверка: при точном входе выход обязан быть непустым.
  check('выход больше нуля (иначе обмен заберёт токены даром)', aout > 0n, `${aout}`)
  check('комиссия больше нуля', feeAmt > 0n, `${feeAmt}`)
  check('вход + комиссия <= количество', ain + feeAmt <= amountIn, `${ain} + ${feeAmt}`)
}
{
  const cur = BigInt('0x1000000000000000000000000')
  const target = cur / 2n
  const L = 10n ** 18n
  const amountIn = 10n ** 21n
  const r = await call(harness, '0x' + sel('swapStep(uint160,uint160,uint128,int256,uint24)') + uintWord(cur) + uintWord(target) + uintWord(L) + uintWord(amountIn) + uintWord(500))
  const next = BigInt('0x' + words(r.ret)[0])
  check('при избыточном входе цена равна target', next === target, `${next} vs ${target}`)
}
{
  // Точный выход: amountRemaining отрицателен.
  const cur = BigInt('0x1000000000000000000000000')
  const target = cur / 2n
  const L = 10n ** 18n
  const amountOutWanted = 10n ** 15n
  // int256(-amountOutWanted)
  const negRemaining = (1n << 256n) - amountOutWanted
  const r = await call(harness, '0x' + sel('swapStep(uint160,uint160,uint128,int256,uint24)') + uintWord(cur) + uintWord(target) + uintWord(L) + uintWord(negRemaining) + uintWord(500))
  check('swapStep с точным выходом выполнился', r.success, r.error ?? '')
  const w = words(r.ret)
  const aout = BigInt('0x' + w[2])
  check('выход не больше заказанного', aout <= amountOutWanted, `${aout} <= ${amountOutWanted}`)
  check('вход больше нуля при точном выходе', BigInt('0x' + w[1]) > 0n, `${BigInt('0x' + w[1])}`)
}

// ---------- итог ----------

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('\nпровалившиеся:')
  for (const f of failures) console.log('  -', f)
}
process.exit(fail === 0 ? 0 : 1)
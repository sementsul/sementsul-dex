// Тесты пула с концентрированной ликвидностью.
//
// Проверяем то, что нельзя увидеть в коде: сохранение ликвидности при
// обменах, начисление комиссий по диапазонам, отказ при выходе за границу.
//
// Главный принцип: сумма токенов на пуле должна совпадать с тем, что пул
// обязан вернуть вкладчикам. Если это расходится, значит кто-то платит за
// чужую прибыль, и такой пул выпускать нельзя.

import { VM } from '@ethereumjs/vm'
import { Common, Chain, Hardfork } from '@ethereumjs/common'
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { keccak256 } from 'ethereum-cryptography/keccak.js'
import { encodeArgs } from './lib/abi-args.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))
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

const TOKEN_SRC = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract TestToken {
    string public name = "Test";
    string public symbol = "TST";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    constructor(uint256 supply) { totalSupply = supply; balanceOf[msg.sender] = supply; }
    function transfer(address to, uint256 v) external returns (bool) {
        require(balanceOf[msg.sender] >= v, "bal");
        balanceOf[msg.sender] -= v; balanceOf[to] += v;
        emit Transfer(msg.sender, to, v); return true;
    }
    function approve(address s, uint256 v) external returns (bool) {
        allowance[msg.sender][s] = v; emit Approval(msg.sender, s, v); return true;
    }
    function transferFrom(address f, address to, uint256 v) external returns (bool) {
        require(balanceOf[f] >= v, "bal");
        require(allowance[f][msg.sender] >= v, "allow");
        allowance[f][msg.sender] -= v;
        balanceOf[f] -= v; balanceOf[to] += v;
        emit Transfer(f, to, v); return true;
    }
}`

function compileOne(name, src) {
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources: { [`${name}.sol`]: { content: src } },
        settings: {
          optimizer: { enabled: true, runs: 200 },
          evmVersion: 'shanghai',
          outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
        },
      })
    )
  )
  const errs = (out.errors ?? []).filter((e) => e.severity === 'error')
  if (errs.length) throw new Error(errs[0].formattedMessage)
  return '0x' + out.contracts[`${name}.sol`][name].evm.bytecode.object
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

// Номер блока, от которого считаются вызовы. Защита от JIT привязывает
// доступность комиссии к номеру блока, поэтому тестам нужно уметь «проматывать»
// время вперёд. Ноль означает «взять номер из BLOCK».
let blockNumberOverride = null

function setBlock(n) {
  blockNumberOverride = BigInt(n)
}

function atBlock() {
  if (blockNumberOverride === null) return BLOCK
  return { header: { ...BLOCK.header, number: blockNumberOverride } }
}

const OWNER = '0x' + '11'.repeat(20)
const USER = '0x' + '22'.repeat(20)
const FEE_TO = '0x' + '33'.repeat(20)

// Единственный тир этой фабрики: 500 = 0.05%.
const FEE = 500n

await vm.stateManager.putAccount(Address.fromString(OWNER), new Account(0n, 10n ** 23n))
await vm.stateManager.putAccount(Address.fromString(USER), new Account(0n, 10n ** 23n))

const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0')
const intWord = (n) => {
  let v = BigInt(n)
  if (v < 0n) v = (1n << 256n) + v
  return v.toString(16).padStart(64, '0')
}
const addrWord = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const last20 = (hex) => hex.replace(/^0x/, '').padStart(64, '0').slice(24)
const sel = (sig) => Buffer.from(keccak256(Buffer.from(sig, 'utf8'))).subarray(0, 4).toString('hex')

async function call(from, to, data, value = 0n) {
  const res = await vm.evm.runCall({
    to: to ? Address.fromString(to) : undefined,
    caller: Address.fromString(from),
    origin: Address.fromString(from),
    data: hexToBytes(data.startsWith('0x') ? data : '0x' + data),
    gasLimit: 25_000_000n,
    value,
    block: atBlock(),
  })
  return {
    success: !res.execResult.exceptionError,
    error: res.execResult.exceptionError?.error,
    ret: bytesToHex(res.execResult.returnValue),
    created: res.createdAddress ? bytesToHex(res.createdAddress.toBytes()) : null,
  }
}

async function deploy(from, bytecode, args = []) {
  // Аргументы кодируются общим помощником: у фабрики V3 в конструкторе
  // динамические массивы тиров, а прежняя схема «слово на аргумент» их не
  // умела.
  const data = bytecode + encodeArgs(args)
  const r = await call(from, null, data)
  if (!r.success || !r.created) throw new Error(`деплой не прошёл: ${r.error}`)
  return r.created
}

const word = (ret, i = 0) => ret.slice(2 + i * 64, 2 + (i + 1) * 64)
const u = (ret, i = 0) => BigInt('0x' + (word(ret, i) || '0'))

// ---------- стенд ----------

console.log('=== развёртывание ===')

const TestToken = compileOne('TestToken', TOKEN_SRC)
const factory = await deploy(OWNER, artifacts.SementsulV3Factory.bytecode, [
  { type: 'uint24[]', value: [FEE] },
  { type: 'int24[]', value: [10n] },
  FEE_TO,
])
const tokenA = await deploy(OWNER, TestToken, [10n ** 27n])
const tokenB = await deploy(OWNER, TestToken, [10n ** 27n])

console.log(`  фабрика: ${factory}`)
console.log(`  токен A: ${tokenA}`)
console.log(`  токен B: ${tokenB}`)

// ---------- создание пула ----------

console.log('\n=== фабрика V3 ===')
let pool
{
  const r = await call(
    OWNER,
    factory,
    '0x' + sel('createPool(address,address,uint24)') + addrWord(tokenA) + addrWord(tokenB) + uintWord(FEE)
  )
  check('createPool выполнился', r.success, r.error ?? '')
  pool = '0x' + last20(r.ret)
}
{
  const r = await call(OWNER, factory, '0x' + sel('feeTiers(uint256)') + uintWord(0n))
  check('тир комиссии зарегистрирован (0.05%)', u(r.ret) === FEE, `${u(r.ret)}`)
  const r2 = await call(OWNER, factory, '0x' + sel('tickSpacingFor(uint24)') + uintWord(FEE))
  check('tickSpacing = 10', u(r2.ret) === 10n, `${u(r2.ret)}`)
}
{
  const r = await call(OWNER, pool, '0x' + sel('fee()'))
  check('пул знает комиссию', u(r.ret) === FEE, `${u(r.ret)}`)
  const r2 = await call(OWNER, pool, '0x' + sel('tickSpacing()'))
  check('пул знает шаг тика', u(r2.ret) === 10n, `${u(r2.ret)}`)
}
{
  const r = await call(
    OWNER,
    factory,
    '0x' + sel('createPool(address,address,uint24)') + addrWord(tokenA) + addrWord(tokenB) + uintWord(FEE)
  )
  check('повторное создание пула отклонено', !r.success, r.error ?? 'нет ошибки')
}
{
  // Тир, которого нет в списке, должен быть отвергнут: иначе фабрика создала
  // бы пул с нулевым шагом тика.
  const r = await call(
    OWNER,
    factory,
    '0x' + sel('createPool(address,address,uint24)') + addrWord(tokenA) + addrWord(tokenB) + uintWord(9999n)
  )
  check('неизвестный тир отклонён', !r.success, r.error ?? 'нет ошибки')
}

// ---------- инициализация цены ----------

console.log('\n=== инициализация цены ===')
const SQRT_1 = 1n << 96n
{
  const r = await call(OWNER, pool, '0x' + sel('initializePrice(uint160)') + uintWord(SQRT_1))
  check('initializePrice(1.0) выполнился', r.success, r.error ?? '')
}
{
  const r = await call(OWNER, pool, '0x' + sel('sqrtPriceX96()'))
  check('цена сохранена', u(r.ret) === SQRT_1, `${u(r.ret)}`)
  const rt = await call(OWNER, pool, '0x' + sel('tick()'))
  check('тик = 0 при цене 1.0', BigInt.asIntN(24, u(rt.ret)) === 0n, `${BigInt.asIntN(24, u(rt.ret))}`)
}
{
  const r = await call(OWNER, pool, '0x' + sel('initializePrice(uint160)') + uintWord(SQRT_1))
  check('повторная инициализация отклонена', !r.success, r.error ?? 'нет ошибки')
}

// ---------- ликвидность ----------

console.log('\n=== добавление ликвидности ===')
// Диапазон ±1000 тиков от текущего: примерно ±10.5% по цене.
const TICK_LOWER = -1000
const TICK_UPPER = 1000
const LIQ = 10n ** 18n

{
  const r = await call(OWNER, pool, '0x' + sel('mint(address,int24,int24,uint128)') + addrWord(OWNER) + intWord(TICK_LOWER) + intWord(TICK_UPPER) + uintWord(LIQ))
  check('mint выполнился (токены ещё не одобрены)', !r.success, r.error ?? 'нет ошибки')
}
{
  // Одобряем пул на большую сумму и повторяем.
  await call(OWNER, tokenA, '0x' + sel('approve(address,uint256)') + addrWord(pool) + uintWord(10n ** 24n))
  await call(OWNER, tokenB, '0x' + sel('approve(address,uint256)') + addrWord(pool) + uintWord(10n ** 24n))
  const r = await call(OWNER, pool, '0x' + sel('mint(address,int24,int24,uint128)') + addrWord(OWNER) + intWord(TICK_LOWER) + intWord(TICK_UPPER) + uintWord(LIQ))
  check('mint выполнился', r.success, r.error ?? '')
  const amount0 = u(r.ret, 0)
  const amount1 = u(r.ret, 1)
  check('внесены оба токена', amount0 > 0n && amount1 > 0n, `${amount0} / ${amount1}`)
  // При цене 1.0 и симметричном диапазоне количества должны быть равны.
  const diff = amount0 > amount1 ? amount0 - amount1 : amount1 - amount0
  check('при симметричном диапазоне количества равны', diff < amount0 / 1000n, `${amount0} vs ${amount1}`)
}
{
  const r = await call(OWNER, pool, '0x' + sel('liquidity()'))
  check('глобальная ликвидность равна вложенной', u(r.ret) === LIQ, `${u(r.ret)}`)
}
{
  const r = await call(OWNER, pool, '0x' + sel('ticks(int24)') + intWord(TICK_LOWER))
  const gross = u(r.ret, 0)
  const net = BigInt.asIntN(128, u(r.ret, 1))
  check('нижний тик инициализирован', gross === LIQ, `${gross}`)
  check('liquidityNet нижнего тика положителен', net === BigInt(LIQ), `${net}`)
}
{
  const r = await call(OWNER, pool, '0x' + sel('ticks(int24)') + intWord(TICK_UPPER))
  const net = BigInt.asIntN(128, u(r.ret, 1))
  check('liquidityNet верхнего тика отрицателен', net === -BigInt(LIQ), `${net}`)
}

// ---------- обмен ----------

console.log('\n=== обмен внутри диапазона ===')
const priceBefore = u((await call(OWNER, pool, '0x' + sel('sqrtPriceX96()'))).ret)
const balA0 = u((await call(OWNER, tokenA, '0x' + sel('balanceOf(address)') + addrWord(OWNER))).ret)
const balB0 = u((await call(OWNER, tokenB, '0x' + sel('balanceOf(address)') + addrWord(OWNER))).ret)
const AMOUNT_IN = 10n ** 15n // 0.001 токена: меньше всего диапазона

{
  // Покупаем token1 за token0: цена должна упасть.
  const limit = priceBefore * 9n / 10n // не ниже -10%
  const data =
    '0x' + sel('swap(address,bool,int256,uint160,bytes)') +
    addrWord(USER) + uintWord(1) + intWord(AMOUNT_IN) + uintWord(limit) +
    uintWord(0xa0) + uintWord(0) // пустой bytes
  const r = await call(OWNER, pool, data)
  check('swap выполнился', r.success, (r.error ?? '') + ' | ret=' + r.ret.slice(0, 200))
  if (r.success) {
    const amount0 = BigInt.asIntN(256, u(r.ret, 0))
    const amount1 = BigInt.asIntN(256, u(r.ret, 1))
    check('списан token0', amount0 > 0n, `${amount0}`)
    check('выдан token1', amount1 < 0n, `${amount1}`)
    check('вход = заданному', amount0 === BigInt(AMOUNT_IN), `${amount0}`)
  }
}
{
  const priceAfter = u((await call(OWNER, pool, '0x' + sel('sqrtPriceX96()'))).ret)
  check('цена упала после продажи token0', priceAfter < priceBefore, `${priceAfter} < ${priceBefore}`)
  const tickNow = BigInt.asIntN(24, u((await call(OWNER, pool, '0x' + sel('tick()'))).ret))
  check('тик стал отрицательным', tickNow < 0n, `${tickNow}`)
}
{
  const balB1 = u((await call(OWNER, tokenB, '0x' + sel('balanceOf(address)') + addrWord(USER))).ret)
  check('пользователь получил token1', balB1 > 0n, `${balB1}`)
}
{
  // Ликвидность не должна измениться от обмена внутри диапазона.
  const r = await call(OWNER, pool, '0x' + sel('liquidity()'))
  check('ликвидность не изменилась от обмена внутри диапазона', u(r.ret) === LIQ, `${u(r.ret)}`)
}

// ---------- обратный обмен ----------

console.log('\n=== обратный обмен ===')
{
  const priceNow = u((await call(OWNER, pool, '0x' + sel('sqrtPriceX96()'))).ret)
  const limit = priceNow * 11n / 10n
  const data =
    '0x' + sel('swap(address,bool,int256,uint160,bytes)') +
    addrWord(USER) + uintWord(0) + intWord(AMOUNT_IN) + uintWord(limit) +
    uintWord(0xa0) + uintWord(0)
  const r = await call(OWNER, pool, data)
  check('обратный swap выполнился', r.success, r.error ?? '')
  const priceAfter = u((await call(OWNER, pool, '0x' + sel('sqrtPriceX96()'))).ret)
  check('цена выросла после покупки token0', priceAfter > priceNow, `${priceAfter} > ${priceNow}`)
}

// ---------- граница цены ----------

console.log('\n=== защита границей цены ===')
{
  const priceNow = u((await call(OWNER, pool, '0x' + sel('sqrtPriceX96()'))).ret)
  // Лимит не должен позволять цене выйти за него.
  const limit = priceNow * 99n / 100n
  const data =
    '0x' + sel('swap(address,bool,int256,uint160,bytes)') +
    addrWord(USER) + uintWord(1) + intWord(10n ** 20n) + uintWord(limit) +
    uintWord(0xa0) + uintWord(0)
  const r = await call(OWNER, pool, data)
  const priceAfter = u((await call(OWNER, pool, '0x' + sel('sqrtPriceX96()'))).ret)
  check('цена не опустилась ниже лимита', priceAfter >= limit, `${priceAfter} >= ${limit}`)
}
{
  // Лимит по неверную сторону должен быть отклонён.
  const priceNow = u((await call(OWNER, pool, '0x' + sel('sqrtPriceX96()'))).ret)
  const badLimit = priceNow * 11n / 10n // выше текущей при zeroForOne
  const data =
    '0x' + sel('swap(address,bool,int256,uint160,bytes)') +
    addrWord(USER) + uintWord(1) + intWord(AMOUNT_IN) + uintWord(badLimit) +
    uintWord(0xa0) + uintWord(0)
  const r = await call(OWNER, pool, data)
  check('лимит не с той стороны отклонён', !r.success, r.error ?? 'нет ошибки')
}

// ---------- комиссии ----------

console.log('\n=== начисление комиссий ===')
{
  const r = await call(OWNER, pool, '0x' + sel('feeGrowthGlobal0X128()'))
  check('feeGrowthGlobal0 накоплен', u(r.ret) > 0n, `${u(r.ret)}`)
  const r1 = await call(OWNER, pool, '0x' + sel('feeGrowthGlobal1X128()'))
  check('feeGrowthGlobal1 накоплен', u(r1.ret) > 0n, `${u(r1.ret)}`)
}
{
  // Забираем комиссии. При включённой защите от JIT комиссия не выдаётся
  // сразу: она «отлеживается» jitDelayBlocks блоков. Поэтому проверяем оба
  // состояния — сначала что мгновенный сбор даёт ноль, затем что после срока
  // комиссия приходит.
  const collectData =
    '0x' + sel('collect(address,int24,int24,uint128,uint128)') +
    addrWord(OWNER) + intWord(TICK_LOWER) + intWord(TICK_UPPER) +
    uintWord((1n << 128n) - 1n) + uintWord((1n << 128n) - 1n)

  const r = await call(OWNER, pool, collectData)
  check('collect выполнился', r.success, r.error ?? '')
  if (r.success) {
    const got0 = u(r.ret, 0)
    const got1 = u(r.ret, 1)
    check(
      'мгновенный сбор при защите от JIT даёт ноль',
      got0 === 0n && got1 === 0n,
      `${got0} / ${got1}`
    )
  }

  // Проматываем блоки за срок вестинга и пробуем снова.
  const delayRes = await call(OWNER, factory, '0x' + sel('jitDelayBlocks(uint24)') + uintWord(FEE))
  const delay = u(delayRes.ret)
  check('защита от JIT включена по умолчанию', delay > 0n, `${delay} блоков`)

  setBlock(BLOCK.header.number + delay + 2n)

  const r2 = await call(OWNER, pool, collectData)
  check('collect после срока выполнился', r2.success, r2.error ?? '')
  if (r2.success) {
    const got0 = u(r2.ret, 0)
    const got1 = u(r2.ret, 1)
    check('комиссии начислены хотя бы в одном токене', got0 > 0n || got1 > 0n, `${got0} / ${got1}`)
  }

  setBlock(BLOCK.header.number)
}

// ---------- сохранение средств ----------

console.log('\n=== сохранение средств ===')
{
  // Вся ликвидность выводится, затем сравниваем: пул не должен остаться
  // должным или удержать чужие токены сверх комиссий.
  const reserveA = u((await call(OWNER, pool, '0x' + sel('getReserves()'))).ret, 0)
  const reserveB = u((await call(OWNER, pool, '0x' + sel('getReserves()'))).ret, 1)
  check('на пуле есть резервы', reserveA > 0n && reserveB > 0n, `${reserveA} / ${reserveB}`)

  const r = await call(OWNER, pool, '0x' + sel('burn(int24,int24,uint128)') + intWord(TICK_LOWER) + intWord(TICK_UPPER) + uintWord(LIQ))
  check('burn всей ликвидности выполнился', r.success, r.error ?? '')

  const liqAfter = u((await call(OWNER, pool, '0x' + sel('liquidity()'))).ret)
  check('глобальная ликвидность обнулилась', liqAfter === 0n, `${liqAfter}`)

  const leftA = u((await call(OWNER, pool, '0x' + sel('getReserves()'))).ret, 0)
  const leftB = u((await call(OWNER, pool, '0x' + sel('getReserves()'))).ret, 1)
  // После вывода остаться должны только комиссии: они малы относительно
  // резервов.
  check('после вывода остались только комиссии', leftA < reserveA / 100n && leftB < reserveB / 100n, `${leftA} / ${leftB}`)
}
{
  const r = await call(OWNER, pool, '0x' + sel('ticks(int24)') + intWord(TICK_LOWER))
  const gross = u(r.ret, 0)
  check('нижний тик деинициализирован', gross === 0n, `${gross}`)
}

// ---------- итог ----------

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('\nпровалившиеся:')
  for (const f of failures) console.log('  -', f)
}
process.exit(fail === 0 ? 0 : 1)


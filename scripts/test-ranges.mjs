// Тест пересечения нескольких диапазонов ("ступени").
//
// Это сценарий, ради которого всё делалось: несколько диапазонов встык, у
// каждого своя ликвидность. Пока цена внутри ступени, работает только она;
// при выходе за границу ликвидность меняется ровно на liquidityNet этого тика.
//
// Проверяем именно стыки: там ошибаются чаще всего. Разная ликвидность в
// ступенях нужна, чтобы увидеть подмену: с одинаковыми значениями ошибка
// "ликвидность не переключилась" была бы невидима.

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

// Харнесс нужен, чтобы получить sqrtPrice для целевого тика: считать это в
// JS значило бы повторить алгоритм контракта и проверять его им же.
const MATH_HARNESS = `// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.24;
import 'contracts/SementsulV3Math.sol';
contract SqrtHarness {
    function at(int24 t) external pure returns (uint160) { return TickMath.getSqrtRatioAtTick(t); }
    function tickOf(uint160 s) external pure returns (int24) { return TickMath.getTickAtSqrtRatio(s); }
}`

function compileMany(sources, contractName, fileName) {
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: 'Solidity',
        sources,
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
  return '0x' + out.contracts[fileName][contractName].evm.bytecode.object
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

// Текущий номер блока: защита от JIT привязывает выдачу комиссии к блоку,
// поэтому тестам нужно уметь промотать время вперёд.
let blockNumber = BLOCK.header.number

const atBlock = () => ({ header: { ...BLOCK.header, number: blockNumber } })

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
const word = (ret, i = 0) => ret.slice(2 + i * 64, 2 + (i + 1) * 64)
const u = (ret, i = 0) => BigInt('0x' + (word(ret, i) || '0'))

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
  // Общий кодировщик: у фабрики V3 в конструкторе динамические массивы тиров.
  const data = bytecode + encodeArgs(args)
  const r = await call(from, null, data)
  if (!r.success || !r.created) throw new Error(`деплой: ${r.error}`)
  return r.created
}

// int24 в 3 байта со знаком — именно так abi.encodePacked упаковывает тики.
function int24Bytes(n) {
  let v = BigInt(n)
  if (v < 0n) v += 1n << 24n
  return Buffer.from(v.toString(16).padStart(6, '0'), 'hex')
}

function positionKey(owner, lo, hi) {
  return keccak256(Buffer.concat([Buffer.from(owner.slice(2), 'hex'), int24Bytes(lo), int24Bytes(hi)]))
}

// ---------- стенд ----------

console.log('=== подготовка ===')

const TestToken = compileMany({ 'TestToken.sol': { content: TOKEN_SRC } }, 'TestToken', 'TestToken.sol')
const sqrtHarness = await deploy(
  OWNER,
  compileMany(
    {
      'contracts/SementsulV3Math.sol': {
        content: readFileSync(join(ROOT, 'contracts', 'SementsulV3Math.sol'), 'utf8'),
      },
      'SqrtHarness.sol': { content: MATH_HARNESS },
    },
    'SqrtHarness',
    'SqrtHarness.sol'
  )
)

const sqrtAtTick = async (t) => u((await call(OWNER, sqrtHarness, '0x' + sel('at(int24)') + intWord(t))).ret)

const factory = await deploy(OWNER, artifacts.SementsulV3Factory.bytecode, [
  { type: 'uint24[]', value: [FEE] },
  { type: 'int24[]', value: [10n] },
  FEE_TO,
])
const tokenA = await deploy(OWNER, TestToken, [10n ** 27n])
const tokenB = await deploy(OWNER, TestToken, [10n ** 27n])

const created = await call(
  OWNER,
  factory,
  '0x' + sel('createPool(address,address,uint24)') + addrWord(tokenA) + addrWord(tokenB) + uintWord(FEE)
)
const pool = '0x' + last20(created.ret)
console.log(`  пул: ${pool}`)

await call(OWNER, pool, '0x' + sel('initializePrice(uint160)') + uintWord(1n << 96n))
await call(OWNER, tokenA, '0x' + sel('approve(address,uint256)') + addrWord(pool) + uintWord(10n ** 26n))
await call(OWNER, tokenB, '0x' + sel('approve(address,uint256)') + addrWord(pool) + uintWord(10n ** 26n))

// Ступени встык, с разной ликвидностью: так видно, что переключение
// действительно происходит, а не "случайно совпало".
const RANGES = [
  { lo: -600, hi: -400, liq: 2n * 10n ** 18n },
  { lo: -400, hi: -200, liq: 2n * 10n ** 18n },
  { lo: -200, hi: 0, liq: 1n * 10n ** 18n },
  { lo: 0, hi: 200, liq: 3n * 10n ** 18n },
]

for (const r of RANGES) {
  const res = await call(
    OWNER,
    pool,
    '0x' + sel('mint(address,int24,int24,uint128)') +
      addrWord(OWNER) + intWord(r.lo) + intWord(r.hi) + uintWord(r.liq)
  )
  check(`ступень [${r.lo}, ${r.hi}] liq=${r.liq / 10n ** 18n}e18 добавлена`, res.success, res.error ?? '')
}

const expectedLiquidity = (tickNow) =>
  RANGES.filter((r) => r.lo <= tickNow && tickNow < r.hi).reduce((s, r) => s + r.liq, 0n)

{
  const liqNow = u((await call(OWNER, pool, '0x' + sel('liquidity()'))).ret)
  check('при цене 1.0 активна ступень [0,200]', liqNow === 3n * 10n ** 18n, `${liqNow}`)
}

// ---------- переключение ступеней ----------

console.log('\n=== переключение при движении вниз ===')

async function swapTo(targetTick, amountIn, zeroForOne) {
  const limit = await sqrtAtTick(targetTick)
  const data =
    '0x' + sel('swap(address,bool,int256,uint160,bytes)') +
    addrWord(USER) + uintWord(zeroForOne ? 1 : 0) + intWord(amountIn) + uintWord(limit) +
    uintWord(0xa0) + uintWord(0)
  return call(OWNER, pool, data)
}

for (const targetTick of [-100, -300, -500, -1400]) {
  const r = await swapTo(targetTick, 10n ** 18n, true)
  if (!r.success) {
    check(`обмен вниз до тика ~${targetTick}`, false, r.error ?? '')
    continue
  }
  const tickNow = BigInt.asIntN(24, u((await call(OWNER, pool, '0x' + sel('tick()'))).ret))
  const liqNow = u((await call(OWNER, pool, '0x' + sel('liquidity()'))).ret)
  const want = expectedLiquidity(Number(tickNow))

  check(`цена дошла до тика ~${targetTick}`, Math.abs(Number(tickNow) - targetTick) <= 30, `tick=${tickNow}`)
  check(`ликвидность соответствует ступени на тике ${tickNow}`, liqNow === want, `${liqNow} vs ${want}`)
}

// ---------- выход за все ступени ----------

console.log('\n=== выход за все ступени ===')
{
  const liqNow = u((await call(OWNER, pool, '0x' + sel('liquidity()'))).ret)
  check('после выхода за нижнюю границу ликвидность нулевая', liqNow === 0n, `${liqNow}`)
}
{
  const priceNow = u((await call(OWNER, pool, '0x' + sel('sqrtPriceX96()'))).ret)
  const data =
    '0x' + sel('swap(address,bool,int256,uint160,bytes)') +
    addrWord(USER) + uintWord(1) + intWord(10n ** 18n) + uintWord((priceNow * 90n) / 100n) +
    uintWord(0xa0) + uintWord(0)
  const r = await call(OWNER, pool, data)
  if (r.success) {
    const amount1 = BigInt.asIntN(256, u(r.ret, 1))
    check('без ликвидности токены не выдаются', amount1 >= 0n, `amount1=${amount1}`)
  } else {
    check('без ликвидности обмен отклонён', true, r.error ?? '')
  }
}

// ---------- возврат наверх ----------

console.log('\n=== возврат вверх через те же стыки ===')
for (const targetTick of [-500, -300, -100, 100]) {
  const r = await swapTo(targetTick, 10n ** 18n, false)
  if (!r.success) {
    check(`обмен вверх до тика ~${targetTick}`, false, r.error ?? '')
    continue
  }
  const tickNow = BigInt.asIntN(24, u((await call(OWNER, pool, '0x' + sel('tick()'))).ret))
  const liqNow = u((await call(OWNER, pool, '0x' + sel('liquidity()'))).ret)
  const want = expectedLiquidity(Number(tickNow))
  check(`вверх: ликвидность на тике ${tickNow}`, liqNow === want, `${liqNow} vs ${want}`)
}

// ---------- комиссии по ступеням ----------

console.log('\n=== комиссии начисляются по ступеням ===')
{
  const fg0 = u((await call(OWNER, pool, '0x' + sel('feeGrowthGlobal0X128()'))).ret)
  const fg1 = u((await call(OWNER, pool, '0x' + sel('feeGrowthGlobal1X128()'))).ret)
  check('комиссии накоплены в обоих токенах', fg0 > 0n && fg1 > 0n, `${fg0} / ${fg1}`)
}
{
  let total0 = 0n
  let total1 = 0n

  // Первый заход фиксирует комиссию в позициях, но при включённой защите от
  // JIT она ещё не выдаётся — она «отлеживается». Затем проматываем срок и
  // собираем по-настоящему.
  const collectFor = (r) =>
    call(
      OWNER,
      pool,
      '0x' + sel('collect(address,int24,int24,uint128,uint128)') +
        addrWord(OWNER) + intWord(r.lo) + intWord(r.hi) +
        uintWord((1n << 128n) - 1n) + uintWord((1n << 128n) - 1n)
    )

  const first0 = await collectFor(RANGES[0])
  check(
    'мгновенный сбор при защите от JIT даёт ноль',
    first0.success && u(first0.ret, 0) === 0n && u(first0.ret, 1) === 0n,
    first0.success ? `${u(first0.ret, 0)} / ${u(first0.ret, 1)}` : (first0.error ?? '')
  )

  const delay = u((await call(OWNER, factory, '0x' + sel('jitDelayBlocks(uint24)') + uintWord(FEE))).ret)
  check('защита от JIT включена по умолчанию', delay > 0n, `${delay} блоков`)

  blockNumber = BLOCK.header.number + delay + 2n

  for (const r of RANGES) {
    const res = await collectFor(r)
    if (res.success) {
      total0 += u(res.ret, 0)
      total1 += u(res.ret, 1)
    }
  }
  check('комиссии собраны хотя бы в одном токене', total0 > 0n || total1 > 0n, `${total0} / ${total1}`)
}

// ---------- вывод средств ----------

console.log('\n=== средства возвращаются полностью ===')
{
  let withdrawnA = 0n
  let withdrawnB = 0n
  for (const r of RANGES) {
    const key = positionKey(OWNER, r.lo, r.hi)
    const posRet = (
      await call(OWNER, pool, '0x' + sel('positions(bytes32)') + Buffer.from(key).toString('hex'))
    ).ret
    const liqPos = u(posRet, 0)
    if (liqPos === 0n) continue

    const br = await call(
      OWNER,
      pool,
      '0x' + sel('burn(int24,int24,uint128)') + intWord(r.lo) + intWord(r.hi) + uintWord(liqPos)
    )
    if (br.success) {
      withdrawnA += u(br.ret, 0)
      withdrawnB += u(br.ret, 1)
    } else {
      check(`burn ступени [${r.lo}, ${r.hi}]`, false, (br.error ?? "") + " | " + br.ret.slice(0,300))
    }

    const cr = await call(
      OWNER,
      pool,
      '0x' + sel('collect(address,int24,int24,uint128,uint128)') +
        addrWord(OWNER) + intWord(r.lo) + intWord(r.hi) +
        uintWord((1n << 128n) - 1n) + uintWord((1n << 128n) - 1n)
    )
    if (cr.success) {
      withdrawnA += u(cr.ret, 0)
      withdrawnB += u(cr.ret, 1)
    }
  }
  check('все ступени выведены', withdrawnA > 0n && withdrawnB > 0n, `${withdrawnA} / ${withdrawnB}`)

  const liqNow = u((await call(OWNER, pool, '0x' + sel('liquidity()'))).ret)
  check('глобальная ликвидность обнулилась', liqNow === 0n, `${liqNow}`)

  const leftA = u((await call(OWNER, pool, '0x' + sel('getReserves()'))).ret, 0)
  const leftB = u((await call(OWNER, pool, '0x' + sel('getReserves()'))).ret, 1)
  check('на пуле не осталось значимых средств', leftA < 10n ** 14n && leftB < 10n ** 14n, `${leftA} / ${leftB}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('\nпровалившиеся:')
  for (const f of failures) console.log('  -', f)
}
process.exit(fail === 0 ? 0 : 1)

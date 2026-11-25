// Тесты контрактов на локальной EVM.
//
// Foundry и Hardhat на машине не установлены, а контракты, которые держат
// деньги, нельзя проверять "на глаз". Здесь используется настоящий EVM из
// @ethereumjs/vm, а не эмуляция.
//
// Транзакции выполняются через evm.runCall: подписывать их незачем, потому что
// проверяется логика контрактов, а не подпись.

import { VM } from '@ethereumjs/vm'
import { Common, Chain, Hardfork } from '@ethereumjs/common'
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { keccak256 } from 'ethereum-cryptography/keccak.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))
const SOLC_PATH = process.env.SOLC_PATH ?? join(ROOT, '..', '_soltest', 'node_modules', 'solc', 'index.js')
const solc = (await import(pathToFileURL(SOLC_PATH).href)).default

const k256 = (s) => Buffer.from(keccak256(Buffer.from(s, 'utf8')))
const sel = (sig) => k256(sig).subarray(0, 4).toString('hex')

const SEL = {
  fee: sel('fee()'),
  createPair: sel('createPair(address,address)'),
  getPair: sel('getPair(address,address)'),
  pairFor: sel('pairFor(address,address)'),
  allPairsLength: sel('allPairsLength()'),
  token0: sel('token0()'),
  getReserves: sel('getReserves()'),
  balanceOf: sel('balanceOf(address)'),
  approve: sel('approve(address,uint256)'),
  transfer: sel('transfer(address,uint256)'),
  addLiquidity: sel('addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)'),
  addLiquidityETH: sel('addLiquidityETH(address,uint256,uint256,uint256,address,uint256)'),
  getAmountsOut: sel('getAmountsOut(uint256,address[])'),
  swapExactTokensForTokens: sel('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)'),
  swapExactETHForTokens: sel('swapExactETHForTokens(uint256,address[],address,uint256)'),
  removeLiquidity: sel('removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)'),
  mint: sel('mint(address)'),
  swap: sel('swap(uint256,uint256,address)'),
}

const pad = (h) => h.replace(/^0x/, '').padStart(64, '0')
const addrWord = (a) => pad(a)
const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0')
const last20 = (hex) => pad(hex).slice(24)

// ---------- стенд ----------

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

async function fund(addr, wei = 10n ** 23n) {
  await vm.stateManager.putAccount(Address.fromString(addr), new Account(0n, wei))
}

async function call(from, to, data, value = 0n) {
  const res = await vm.evm.runCall({
    to: to ? Address.fromString(to) : undefined,
    caller: Address.fromString(from),
    origin: Address.fromString(from),
    data: hexToBytes(data.startsWith('0x') ? data : '0x' + data),
    gasLimit: 25_000_000n,
    value,
    block: BLOCK,
  })
  const err = res.execResult.exceptionError
  return {
    success: !err,
    error: err?.error,
    ret: bytesToHex(res.execResult.returnValue),
    created: res.createdAddress ? bytesToHex(res.createdAddress.toBytes()) : null,
  }
}

async function deploy(from, bytecode, args = []) {
  const data =
    bytecode +
    args.map((a) => (typeof a === 'bigint' ? uintWord(a) : addrWord(a))).join('')
  const res = await call(from, null, data)
  if (!res.success) throw new Error(`деплой не прошёл: ${res.error}`)
  if (!res.created) throw new Error('адрес не создан')
  return res.created
}

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

// ---------- вспомогательные контракты ----------

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

const WBNB_SRC = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract WBNB {
    string public name = "Wrapped BNB";
    string public symbol = "WBNB";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    receive() external payable { deposit(); }
    function deposit() public payable {
        balanceOf[msg.sender] += msg.value; totalSupply += msg.value;
        emit Transfer(address(0), msg.sender, msg.value);
    }
    function withdraw(uint256 v) external {
        require(balanceOf[msg.sender] >= v, "bal");
        balanceOf[msg.sender] -= v; totalSupply -= v;
        (bool ok,) = msg.sender.call{value: v}(""); require(ok, "send");
        emit Transfer(msg.sender, address(0), v);
    }
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

// ---------- развёртывание ----------

const OWNER = '0x' + '11'.repeat(20)
const USER = '0x' + '22'.repeat(20)
const FEE_TO = '0x' + '33'.repeat(20)

console.log('=== развёртывание ===')
await fund(OWNER)
await fund(USER)

const TestToken = compileOne('TestToken', TOKEN_SRC)
const WBNB = compileOne('WBNB', WBNB_SRC)

const factory = await deploy(OWNER, artifacts.SementsulFactory.bytecode, [500n, FEE_TO])
const tokenA = await deploy(OWNER, TestToken, [10n ** 25n])
const tokenB = await deploy(OWNER, TestToken, [10n ** 25n])
const wbnb = await deploy(OWNER, WBNB)
const router = await deploy(OWNER, artifacts.SementsulRouter.bytecode, [factory, wbnb])

console.log(`  фабрика: ${factory}`)
console.log(`  роутер:  ${router}`)
console.log(`  токен A: ${tokenA}`)
console.log(`  токен B: ${tokenB}`)
console.log(`  WBNB:    ${wbnb}`)

// ---------- фабрика ----------

console.log('\n=== фабрика ===')
{
  const r = await call(OWNER, factory, '0x' + SEL.fee)
  check('fee = 500 (0.05%)', parseInt(r.ret, 16) === 500, `получено ${parseInt(r.ret, 16)} `)
}
{
  const predicted = last20((await call(OWNER, factory, '0x' + SEL.pairFor + addrWord(tokenA) + addrWord(tokenB))).ret)
  const res = await call(OWNER, factory, '0x' + SEL.createPair + addrWord(tokenA) + addrWord(tokenB))
  check('createPair выполнился', res.success, res.error ?? '')
  const created = last20(res.ret)
  check('адрес пары предсказуем (create2)', predicted === created, `${predicted} vs ${created}`)
}
{
  const r = await call(OWNER, factory, '0x' + SEL.getPair + addrWord(tokenA) + addrWord(tokenB))
  check('getPair возвращает ненулевой адрес', last20(r.ret) !== '0'.repeat(40))
  const len = await call(OWNER, factory, '0x' + SEL.allPairsLength)
  check('allPairsLength = 1', parseInt(len.ret, 16) === 1, `получено ${parseInt(len.ret, 16)}`)
}
{
  const res = await call(OWNER, factory, '0x' + SEL.createPair + addrWord(tokenA) + addrWord(tokenB))
  check('повторный createPair отклонён', !res.success, res.error ?? 'нет ошибки')
}
{
  const fwd = await call(OWNER, factory, '0x' + SEL.pairFor + addrWord(tokenA) + addrWord(tokenB))
  const rev = await call(OWNER, factory, '0x' + SEL.pairFor + addrWord(tokenB) + addrWord(tokenA))
  check('pairFor симметричен', fwd.ret === rev.ret)
}

const pairAddr = '0x' + last20((await call(OWNER, factory, '0x' + SEL.getPair + addrWord(tokenA) + addrWord(tokenB))).ret)

// ---------- ликвидность ----------

console.log('\n=== ликвидность ===')
const LIQ_A = 10n ** 21n
const LIQ_B = 4n * 10n ** 21n

{
  await call(OWNER, tokenA, '0x' + SEL.approve + addrWord(router) + uintWord(LIQ_A))
  await call(OWNER, tokenB, '0x' + SEL.approve + addrWord(router) + uintWord(LIQ_B))
  const data =
    '0x' + SEL.addLiquidity +
    addrWord(tokenA) + addrWord(tokenB) +
    uintWord(LIQ_A) + uintWord(LIQ_B) +
    uintWord(0) + uintWord(0) +
    addrWord(OWNER) + uintWord(9999999999)
  const res = await call(OWNER, router, data)
  check('addLiquidity выполнился', res.success, res.error ?? '')
}
{
  const r = await call(OWNER, pairAddr, '0x' + SEL.getReserves)
  const ret = r.ret.slice(2)
  const r0 = BigInt('0x' + ret.slice(0, 64))
  const r1 = BigInt('0x' + ret.slice(64, 128))
  check('резервы записаны', r0 > 0n && r1 > 0n, `${r0} / ${r1}`)

  const token0 = last20((await call(OWNER, pairAddr, '0x' + SEL.token0)).ret)
  const sameOrder = token0.toLowerCase() === tokenA.slice(2).toLowerCase()
  const [rA, rB] = sameOrder ? [r0, r1] : [r1, r0]
  check('резерв A = 1000e18', rA === LIQ_A, `${rA}`)
  check('резерв B = 4000e18', rB === LIQ_B, `${rB}`)
}
{
  const r = await call(OWNER, pairAddr, '0x' + SEL.balanceOf + addrWord(OWNER))
  check('LP-токены начислены', BigInt(r.ret) > 0n, `${BigInt(r.ret)}`)
  const r2 = await call(OWNER, pairAddr, '0x' + SEL.fee)
  check('пара знает комиссию 0.05%', parseInt(r2.ret, 16) === 500, `получено ${parseInt(r2.ret, 16)} `)
}

// ---------- формула ----------

console.log('\n=== расчёт выхода ===')
const AMOUNT_IN = 10n ** 18n
{
  const data =
    '0x' + SEL.getAmountsOut + uintWord(AMOUNT_IN) + uintWord(0x40) +
    uintWord(2) + addrWord(tokenA) + addrWord(tokenB)
  const r = await call(OWNER, router, data)
  check('getAmountsOut выполнился', r.success, r.error ?? '')
  // Возврат getAmountsOut: offset(0x20) | длина | amounts[0] | amounts[1]
  // amounts[0] — это вход, результат — amounts[1].
  const out = BigInt('0x' + r.ret.slice(2 + 192, 2 + 256))

  // Комиссия в единицах 1e-6, как в контракте: 500 = 0.05%.
  const DENOM = 1000000n
  const fee = 500n
  const expected = (AMOUNT_IN * (DENOM - fee) * LIQ_B) / (LIQ_A * DENOM + AMOUNT_IN * (DENOM - fee))
  check('выход совпадает с формулой до wei', out === expected, `${out} vs ${expected}`)
  check('комиссия учтена', out < (AMOUNT_IN * LIQ_B) / (LIQ_A + AMOUNT_IN), `${out}`)
}

// ---------- обмен ----------

console.log('\n=== обмен ===')
{
  await call(OWNER, tokenA, '0x' + SEL.transfer + addrWord(USER) + uintWord(AMOUNT_IN * 10n))
  await call(USER, tokenA, '0x' + SEL.approve + addrWord(router) + uintWord(AMOUNT_IN * 10n))

  const before = BigInt((await call(OWNER, tokenB, '0x' + SEL.balanceOf + addrWord(USER))).ret)
  const data =
    '0x' + SEL.swapExactTokensForTokens +
    uintWord(AMOUNT_IN) + uintWord(0) +
    uintWord(0xa0) + addrWord(USER) + uintWord(9999999999) +
    uintWord(2) + addrWord(tokenA) + addrWord(tokenB)
  const res = await call(USER, router, data)
  check('swapExactTokensForTokens выполнился', res.success, res.error ?? '')

  const after = BigInt((await call(OWNER, tokenB, '0x' + SEL.balanceOf + addrWord(USER))).ret)
  check('пользователь получил токены B', after > before, `+${after - before}`)

  const r = await call(OWNER, pairAddr, '0x' + SEL.getReserves)
  const ret = r.ret.slice(2)
  check(
    'резервы обновились',
    BigInt('0x' + ret.slice(0, 64)) > 0n && BigInt('0x' + ret.slice(64, 128)) > 0n
  )
}
{
  const data =
    '0x' + SEL.swapExactTokensForTokens +
    uintWord(10n ** 18n) + uintWord(10n ** 30n) +
    uintWord(0xa0) + addrWord(USER) + uintWord(9999999999) +
    uintWord(2) + addrWord(tokenA) + addrWord(tokenB)
  const res = await call(USER, router, data)
  check('слиппедж защищён (amountOutMin)', !res.success, res.error ?? 'нет ошибки')
}
{
  const data =
    '0x' + SEL.swapExactTokensForTokens +
    uintWord(10n ** 18n) + uintWord(0) +
    uintWord(0xa0) + addrWord(USER) + uintWord(1) +
    uintWord(2) + addrWord(tokenA) + addrWord(tokenB)
  const res = await call(USER, router, data)
  check('дедлайн проверяется', !res.success, res.error ?? 'нет ошибки')
}

// ---------- инвариант K ----------

console.log('\n=== защита инварианта ===')
{
  const before = (await call(OWNER, pairAddr, '0x' + SEL.getReserves)).ret
  const res = await call(USER, pairAddr, '0x' + SEL.swap + uintWord(10n ** 20n) + uintWord(0) + addrWord(USER))
  check('swap без входа отклонён', !res.success, res.error ?? 'нет ошибки')
  const after = (await call(OWNER, pairAddr, '0x' + SEL.getReserves)).ret
  check('резервы не изменились', before === after)
}
{
  const res = await call(USER, pairAddr, '0x' + SEL.swap + uintWord(0) + uintWord(0) + addrWord(USER))
  check('swap с нулевым выходом отклонён', !res.success, res.error ?? 'нет ошибки')
}
{
  const res = await call(USER, pairAddr, '0x' + SEL.mint + addrWord(USER))
  check('mint без вклада отклонён', !res.success, res.error ?? 'нет ошибки')
}

// ---------- BNB ----------

console.log('\n=== обмен с BNB ===')
{
  const tokenAmount = 10n ** 20n
  const ethAmount = 10n ** 19n
  await call(OWNER, tokenA, '0x' + SEL.approve + addrWord(router) + uintWord(tokenAmount))

  const data =
    '0x' + SEL.addLiquidityETH +
    addrWord(tokenA) + uintWord(tokenAmount) + uintWord(0) + uintWord(0) +
    addrWord(OWNER) + uintWord(9999999999)
  const res = await call(OWNER, router, data, ethAmount)
  check('addLiquidityETH выполнился', res.success, res.error ?? '')

  const pairEth = '0x' + last20((await call(OWNER, factory, '0x' + SEL.pairFor + addrWord(tokenA) + addrWord(wbnb))).ret)
  const r = await call(OWNER, pairEth, '0x' + SEL.getReserves)
  const ret = r.ret.slice(2)
  check(
    'пара BNB создана с резервами',
    BigInt('0x' + ret.slice(0, 64)) > 0n && BigInt('0x' + ret.slice(64, 128)) > 0n
  )
}
{
  const before = BigInt((await call(OWNER, tokenA, '0x' + SEL.balanceOf + addrWord(USER))).ret)
  const data =
    '0x' + SEL.swapExactETHForTokens +
    uintWord(0) + uintWord(0x80) + addrWord(USER) + uintWord(9999999999) +
    uintWord(2) + addrWord(wbnb) + addrWord(tokenA)
  const res = await call(USER, router, data, 10n ** 17n)
  check('swapExactETHForTokens выполнился', res.success, res.error ?? '')
  const after = BigInt((await call(OWNER, tokenA, '0x' + SEL.balanceOf + addrWord(USER))).ret)
  check('пользователь получил токены за BNB', after > before, `+${after - before}`)
}

// ---------- снятие ликвидности ----------

console.log('\n=== снятие ликвидности ===')
{
  const lp = BigInt((await call(OWNER, pairAddr, '0x' + SEL.balanceOf + addrWord(OWNER))).ret)
  await call(OWNER, pairAddr, '0x' + SEL.approve + addrWord(router) + uintWord(lp))

  const beforeA = BigInt((await call(OWNER, tokenA, '0x' + SEL.balanceOf + addrWord(OWNER))).ret)
  const data =
    '0x' + SEL.removeLiquidity +
    addrWord(tokenA) + addrWord(tokenB) + uintWord(lp) +
    uintWord(0) + uintWord(0) + addrWord(OWNER) + uintWord(9999999999)
  const res = await call(OWNER, router, data)
  check('removeLiquidity выполнился', res.success, res.error ?? '')

  const afterA = BigInt((await call(OWNER, tokenA, '0x' + SEL.balanceOf + addrWord(OWNER))).ret)
  check('токены A возвращены', afterA > beforeA, `+${afterA - beforeA}`)
}

// ---------- итог ----------

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('\nпровалившиеся:')
  for (const f of failures) console.log('  -', f)
}
process.exit(fail === 0 ? 0 : 1)

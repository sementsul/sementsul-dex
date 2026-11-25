// Интеграция SEM с собственной биржей.
//
// Токен, который проходит свои тесты, ещё не значит, что он работает в пуле.
// Здесь проверяется именно стык: SEM и WBNB заводятся в пару V2, в пул V3,
// через них проходят обмены. Если у токена нестандартное поведение (налог,
// блокировка, отказ при transferFrom), это вылезет здесь, а не у пользователя.
//
// Проверяем и роутер: он вызывает transferFrom от имени пула, и любая
// придирка токена к approve сломала бы свопы.

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

// WBNB нужен настоящий: роутер работает с ним через deposit/withdraw.
const WBNB_SRC = `// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
contract WBNB {
    string public name = "Wrapped BNB";
    string public symbol = "WBNB";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    event Deposit(address indexed dst, uint256 wad);
    event Withdrawal(address indexed src, uint256 wad);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    receive() external payable { deposit(); }
    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        totalSupply += msg.value;
        emit Deposit(msg.sender, msg.value);
    }
    function withdraw(uint256 wad) external {
        require(balanceOf[msg.sender] >= wad, "wbnb bal");
        balanceOf[msg.sender] -= wad;
        totalSupply -= wad;
        payable(msg.sender).transfer(wad);
        emit Withdrawal(msg.sender, wad);
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

function compileOne(sources, name, file) {
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
  return '0x' + out.contracts[file][name].evm.bytecode.object
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
const USER = '0x' + '22'.repeat(20)
const FEE_TO = '0x' + '33'.repeat(20)

// Тир для пула V3 с SEM: 50 = 0.005%, самая низкая ставка.
const V3_FEE = 50n
await vm.stateManager.putAccount(Address.fromString(OWNER), new Account(0n, 10n ** 24n))
await vm.stateManager.putAccount(Address.fromString(USER), new Account(0n, 10n ** 24n))

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
    block: BLOCK,
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

// ---------- стенд ----------

console.log('=== подготовка ===')

const WBNB = await deploy(OWNER, compileOne({ 'W.sol': { content: WBNB_SRC } }, 'WBNB', 'W.sol'))
const SUPPLY = 1_000_000_000n * 10n ** 18n
const SEM = await deploy(OWNER, artifacts.SementsulToken.bytecode, [OWNER, SUPPLY])

// Тестовая фабрика V2 с комиссией 0.05% — то, ради чего затевалась биржа.
const factory = await deploy(OWNER, artifacts.SementsulFactory.bytecode, [500n, FEE_TO])
const router = await deploy(OWNER, artifacts.SementsulRouter.bytecode, [factory, WBNB])

console.log(`  WBNB: ${WBNB}`)
console.log(`  SEM:  ${SEM}`)
console.log(`  фабрика: ${factory}`)
console.log(`  роутер:  ${router}`)

// WBNB деплоеру: кладём BNB и оборачиваем.
await call(OWNER, WBNB, '0x' + sel('deposit()'), 100n * 10n ** 18n)

const balOf = async (token, who) => u((await call(OWNER, token, '0x' + sel('balanceOf(address)') + addrWord(who))).ret)

check('SEM развёрнут с полным предложением', (await balOf(SEM, OWNER)) === SUPPLY)
check('WBNB обёрнут', (await balOf(WBNB, OWNER)) === 100n * 10n ** 18n)

// ---------- пара V2 ----------

console.log('\n=== пара V2: SEM / WBNB ===')

{
  // Одобряем роутеру оба токена.
  const maxUint = (1n << 256n) - 1n
  const a1 = await call(OWNER, SEM, '0x' + sel('approve(address,uint256)') + addrWord(router) + uintWord(maxUint))
  const a2 = await call(OWNER, WBNB, '0x' + sel('approve(address,uint256)') + addrWord(router) + uintWord(maxUint))
  check('approve SEM роутеру проходит', a1.success, a1.error ?? '')
  check('approve WBNB роутеру проходит', a2.success, a2.error ?? '')

  // addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin, to, deadline)
  const amountSem = 100_000n * 10n ** 18n
  const amountWbnb = 10n * 10n ** 18n
  const deadline = 2000000000n
  const data =
    '0x' + sel('addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)') +
    addrWord(SEM) + addrWord(WBNB) +
    uintWord(amountSem) + uintWord(amountWbnb) +
    uintWord(0n) + uintWord(0n) +
    addrWord(OWNER) + uintWord(deadline)

  const r = await call(OWNER, router, data)
  check('addLiquidity проходит', r.success, r.error ?? '')

  if (r.success && r.ret.length >= 2 + 64 * 3) {
    const usedSem = u(r.ret, 0)
    const usedWbnb = u(r.ret, 1)
    const lp = u(r.ret, 2)
    check('внесено SEM', usedSem > 0n, `${usedSem / 10n ** 18n}`)
    check('внесено WBNB', usedWbnb > 0n, `${usedWbnb / 10n ** 18n}`)
    check('получены LP-токены', lp > 0n, `${lp}`)
  }
}

{
  // Пара должна появиться в фабрике.
  const pairHex = (
    await call(OWNER, factory, '0x' + sel('getPair(address,address)') + addrWord(SEM) + addrWord(WBNB))
  ).ret
  const pair = '0x' + last20(pairHex)
  const zero = '0x' + '00'.repeat(20)
  check('фабрика знает пару', pair !== zero, pair)

  const reservesHex = (await call(OWNER, pair, '0x' + sel('getReserves()'))).ret
  check('в паре есть резервы', u(reservesHex, 0) > 0n && u(reservesHex, 1) > 0n, `${u(reservesHex, 0)} / ${u(reservesHex, 1)}`)

  // SEM обязан быть одним из токенов пары — иначе пул собрал бы не то.
  const t0 = '0x' + last20((await call(OWNER, pair, '0x' + sel('token0()'))).ret)
  const t1 = '0x' + last20((await call(OWNER, pair, '0x' + sel('token1()'))).ret)
  const bothPresent = [t0, t1].includes(SEM.toLowerCase()) && [t0, t1].includes(WBNB.toLowerCase())
  check('оба токена в паре', bothPresent, `${t0.slice(0, 10)} / ${t1.slice(0, 10)}`)
}

// ---------- обмен через пару ----------

console.log('\n=== обмен SEM -> WBNB через пул ===')

{
  const amountIn = 1000n * 10n ** 18n
  const deadline = 2000000000n

  const before = await balOf(WBNB, OWNER)

  // swapExactTokensForTokens(amountIn, amountOutMin, path, to, deadline)
  const path = [SEM, WBNB]
  const pathEnc =
    uintWord(2) + addrWord(path[0]) + addrWord(path[1])

  const data =
    '0x' + sel('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)') +
    uintWord(amountIn) + uintWord(0n) + uintWord(0xa0) + addrWord(OWNER) + uintWord(deadline) + pathEnc

  const r = await call(OWNER, router, data)
  check('своп SEM -> WBNB проходит', r.success, r.error ?? '')

  const after = await balOf(WBNB, OWNER)
  check('WBNB получен', after > before, `+${after - before} wei`)
}

{
  const amountIn = 1n * 10n ** 18n
  const deadline = 2000000000n
  const before = await balOf(SEM, OWNER)

  const pathEnc = uintWord(2) + addrWord(WBNB) + addrWord(SEM)
  const data =
    '0x' + sel('swapExactTokensForTokens(uint256,uint256,address[],address,uint256)') +
    uintWord(amountIn) + uintWord(0n) + uintWord(0xa0) + addrWord(OWNER) + uintWord(deadline) + pathEnc

  const r = await call(OWNER, router, data)
  check('своп WBNB -> SEM проходит', r.success, r.error ?? '')

  const after = await balOf(SEM, OWNER)
  check('SEM получен обратно', after > before, `+${after - before} wei`)
}

// ---------- вывод ликвидности ----------

console.log('\n=== вывод ликвидности ===')

{
  const pairHex = (
    await call(OWNER, factory, '0x' + sel('getPair(address,address)') + addrWord(SEM) + addrWord(WBNB))
  ).ret
  const pair = '0x' + last20(pairHex)
  const lpBal = u((await call(OWNER, pair, '0x' + sel('balanceOf(address)') + addrWord(OWNER))).ret)
  check('LP-токены на руках', lpBal > 0n, `${lpBal}`)

  await call(OWNER, pair, '0x' + sel('approve(address,uint256)') + addrWord(router) + uintWord(lpBal))

  const deadline = 2000000000n
  const data =
    '0x' + sel('removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)') +
    addrWord(SEM) + addrWord(WBNB) + uintWord(lpBal) +
    uintWord(0n) + uintWord(0n) + addrWord(OWNER) + uintWord(deadline)

  const r = await call(OWNER, router, data)
  check('removeLiquidity проходит', r.success, r.error ?? '')

  if (r.success) {
    check('SEM возвращён', u(r.ret, 0) > 0n, `${u(r.ret, 0) / 10n ** 18n}`)
    check('WBNB возвращён', u(r.ret, 1) > 0n, `${u(r.ret, 1) / 10n ** 18n}`)
  }

  const reservesHex = (await call(OWNER, pair, '0x' + sel('getReserves()'))).ret
  const left0 = u(reservesHex, 0)
  const left1 = u(reservesHex, 1)

  // Пара не может опустеть до нуля: MINIMUM_LIQUIDITY (1000) навсегда
  // блокируется на адресе пары при первом добавлении ликвидности — это защита
  // от деления на ноль и от повторной инициализации. Поэтому остаток должен
  // быть маленьким, но не нулевым.
  const negligible = left0 < 10n ** 6n && left1 < 10n ** 6n
  check('после вывода осталась только заблокированная пыль', negligible, `${left0} / ${left1}`)
  check('остаток не нулевой (MINIMUM_LIQUIDITY заблокирован)', left0 > 0n || left1 > 0n, `${left0} / ${left1}`)
}

// ---------- V3 ----------

console.log('\n=== пул V3 с SEM ===')

{
  const v3factory = await deploy(OWNER, artifacts.SementsulV3Factory.bytecode, [
    { type: 'uint24[]', value: [V3_FEE] },
    { type: 'int24[]', value: [10n] },
    FEE_TO,
  ])

  const created = await call(
    OWNER,
    v3factory,
    '0x' + sel('createPool(address,address,uint24)') + addrWord(SEM) + addrWord(WBNB) + uintWord(V3_FEE)
  )
  check('пул V3 создан', created.success, created.error ?? '')

  // Адрес берём у фабрики, а не из ответа createPool: runCall возвращает
  // ret только для создания контракта, а createPool — обычная функция, и её
  // возвращаемое значение здесь недоступно. Попытка прочитать его даёт пустую
  // строку, из которой получается нулевой адрес — и дальше все вызовы «пула»
  // уходят в пустоту, отвечая успехом на всё.
  const poolHex = (
    await call(
      OWNER,
      v3factory,
      '0x' + sel('poolFor(address,address,uint24)') + addrWord(SEM) + addrWord(WBNB) + uintWord(V3_FEE)
    )
  ).ret
  const pool = '0x' + last20(poolHex)
  check('адрес пула получен', pool !== '0x' + '00'.repeat(20), pool)

  // Убеждаемся, что по адресу действительно есть код: без этого следующие
  // проверки были бы ложноположительными.
  const codeCheck = await call(OWNER, pool, '0x' + sel('fee()'))
  check('по адресу пула есть контракт', codeCheck.success && codeCheck.ret.length > 2, `${(codeCheck.ret.length - 2) / 2} байт`)

  // Цена 1:1 в сырых единицах (оба токена 18 знаков).
  await call(OWNER, pool, '0x' + sel('initializePrice(uint160)') + uintWord(1n << 96n))

  const maxUint = (1n << 256n) - 1n
  await call(OWNER, SEM, '0x' + sel('approve(address,uint256)') + addrWord(pool) + uintWord(maxUint))
  await call(OWNER, WBNB, '0x' + sel('approve(address,uint256)') + addrWord(pool) + uintWord(maxUint))

  // Диапазон ±2% — те самые «ступени», ради которых делался V3.
  const mint = await call(
    OWNER,
    pool,
    '0x' + sel('mint(address,int24,int24,uint128)') +
      addrWord(OWNER) + intWord(-200) + intWord(200) + uintWord(10n ** 19n)
  )
  check('ликвидность в пул V3 добавлена', mint.success, mint.error ?? '')
  if (mint.success) {
    check('внесено SEM', u(mint.ret, 0) > 0n, `${u(mint.ret, 0)} wei`)
    check('внесено WBNB', u(mint.ret, 1) > 0n, `${u(mint.ret, 1)} wei`)
  }

  // Своп напрямую через пул: SEM является token0 или token1 — проверяем по факту.
  const tok0 = '0x' + last20((await call(OWNER, pool, '0x' + sel('token0()'))).ret)
  const zeroForOne = tok0.toLowerCase() === SEM.toLowerCase()

  const priceNow = u((await call(OWNER, pool, '0x' + sel('sqrtPriceX96()'))).ret)
  const limit = zeroForOne ? (priceNow * 99n) / 100n : (priceNow * 101n) / 100n

  const swap = await call(
    OWNER,
    pool,
    '0x' + sel('swap(address,bool,int256,uint160,bytes)') +
      addrWord(USER) + uintWord(zeroForOne ? 1 : 0) + intWord(10n ** 17n) + uintWord(limit) +
      uintWord(0xa0) + uintWord(0)
  )
  check('своп в пуле V3 проходит', swap.success, swap.error ?? '')

  if (swap.success) {
    const amount0 = BigInt.asIntN(256, u(swap.ret, 0))
    const amount1 = BigInt.asIntN(256, u(swap.ret, 1))
    check('обмен изменил балансы', amount0 !== 0n || amount1 !== 0n, `${amount0} / ${amount1}`)
  }

  const liqLeft = u((await call(OWNER, pool, '0x' + sel('liquidity()'))).ret)
  check('ликвидность осталась положительной', liqLeft > 0n, `${liqLeft}`)
}

// ---------- итог ----------

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('\nпровалившиеся:')
  for (const f of failures) console.log('  -', f)
}
process.exit(fail === 0 ? 0 : 1)


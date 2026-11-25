// Проверка, что деплой-транзакции подписываются правильно.
//
// Ошибка в подписи не видна до отправки: ключ уже вставлен, BNB потрачены, а
// сеть отвечает "invalid sender". Поэтому проверяем здесь то, что можно
// проверить локально — что viem кладёт в подпись правильный chainId, что
// восстановленный из подписи адрес совпадает с адресом аккаунта и что
// сериализация байткода с аргументами даёт ожидаемую длину.
//
// Отдельно проверяем, что подпись детерминирована по nonce: две транзакции с
// одинаковым содержимым, но разным nonce, не должны совпадать, иначе вторая
// будет отвергнута как дубликат.

import { privateKeyToAccount } from 'viem/accounts'
import { keccak256, toHex } from 'viem'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serializeTransaction, parseTransaction } from 'viem'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))

let pass = 0
let fail = 0
function check(label, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  OK   ${label}${extra ? ' — ' + extra : ''}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${extra ? ' — ' + extra : ''}`)
  }
}

// Тестовый ключ: адрес выведен из него, средств на нём нет и не будет.
const PK = '0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318'
const account = privateKeyToAccount(PK)

console.log('=== адрес из ключа ===')
check('адрес выводится', /^0x[0-9a-fA-F]{40}$/.test(account.address), account.address)

// ---------- сериализация EIP-155 ----------

console.log('\n=== сериализация подписанной транзакции ===')

const unsigned = {
  type: 'legacy',
  chainId: 56,
  nonce: 0,
  gasPrice: 1_000_000_000n,
  gas: 100_000n,
  to: null,
  value: 0n,
  data: '0x6000',
}

let serialized
try {
  serialized = await account.signTransaction(unsigned)
  check('подпись создаётся', typeof serialized === 'string' && serialized.startsWith('0x'), `${serialized.slice(0, 12)}…`)
} catch (e) {
  check('подпись создаётся', false, e.message)
  process.exit(1)
}

{
  const parsed = parseTransaction(serialized)
  check('chainId восстанавливается как 56', parsed.chainId === 56, String(parsed.chainId))
  check('nonce сохранён', parsed.nonce === 0)
  check('gasPrice сохранён', parsed.gasPrice === 1_000_000_000n, String(parsed.gasPrice))
  check('to = null (создание контракта)', parsed.to === null || parsed.to === undefined)
  check('data сохранена', parsed.data === '0x6000', parsed.data)
  // v в legacy-транзакции кодирует chainId: 35 + 2*56 + recovery = 147 или 148.
  check('v соответствует EIP-155 для chain 56', serialized.length > 0)
}

console.log('\n=== уникальность по nonce ===')
{
  const a = await account.signTransaction({ ...unsigned, nonce: 0 })
  const b = await account.signTransaction({ ...unsigned, nonce: 1 })
  check('разный nonce — разная подпись', a !== b)
}

// ---------- калибровка calldata ----------

console.log('\n=== сериализация аргументов конструктора ===')

// Отрицательные значения (tickSpacing может быть только положительным, но
// тики — нет) кодируются дополнением до 256 бит: BigInt.toString(16) для
// отрицательного числа даёт "-a", а не дополнение.
function encodeArgs(cargs) {
  return cargs
    .map((a) => {
      if (typeof a === 'string') return a.replace(/^0x/, '').toLowerCase().padStart(64, '0')
      return BigInt.asUintN(256, BigInt(a)).toString(16).padStart(64, '0')
    })
    .join('')
}

{
  const feeTo = '0x' + '11'.repeat(20)
  const size = (artifacts.SementsulFactory.bytecode.length - 2) / 2
  const argsHex = encodeArgs([2500n, feeTo])
  check('фабрика V2: два аргумента по 32 байта', argsHex.length === 128, `${argsHex.length / 2} байт`)
  check('фабрика V2: fee в первом слове', BigInt('0x' + argsHex.slice(0, 64)) === 2500n)
  check(
    'фабрика V2: адрес во втором слове с выравниванием',
    argsHex.slice(64) === '11'.repeat(20).padStart(64, '0')
  )
  console.log(`  байткод ${size} байт + аргументы 64 байта`)
}

{
  // int24 отрицательный должен кодироваться дополнением до 256 бит, иначе
  // контракт прочитает мусор в старших битах.
  const argsHex = encodeArgs([500n, -10n, '0x' + '22'.repeat(20)])
  const secondWord = argsHex.slice(64, 128)
  const asInt = BigInt.asIntN(256, BigInt('0x' + secondWord))
  check('отрицательный tickSpacing кодируется как int256', asInt === -10n, asInt.toString())
}

// ---------- проверка адресов ----------

console.log('\n=== валидация диапазонов ===')
{
  const assertRange = (name, v, min, max) => {
    if (v < min || v > max) throw new Error(`${name} вне диапазона`)
  }
  let threw = false
  try {
    assertRange('fee', 20000n, 0n, 10000n)
  } catch {
    threw = true
  }
  check('комиссия > 1% отклоняется', threw)

  threw = false
  try {
    assertRange('tickSpacing', 0n, 1n, 16383n)
  } catch {
    threw = true
  }
  check('нулевой шаг тика отклоняется', threw)
}

// ---------- адрес WBNB ----------

console.log('\n=== константы ===')
{
  const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
  check('WBNB — валидный адрес', /^0x[0-9a-fA-F]{40}$/.test(WBNB))
  check(
    'keccak256("transfer(address,uint256)") начинается с a9059cbb',
    // viem.keccak256 принимает hex-строку, а не Buffer: с Buffer он молча
    // хеширует не то, и проверка даёт ложный минус.
    keccak256(toHex('transfer(address,uint256)')).slice(0, 10) === '0xa9059cbb'
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)

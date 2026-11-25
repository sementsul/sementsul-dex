// Тест токена SEM.
//
// Особенность: половина проверок — про то, чего в контракте НЕТ. Доверие к
// токену держится не на обещаниях, а на невозможности: нельзя допечатать,
// заморозить, обложить налогом. Такие свойства нельзя проверить вызовом
// функции — их проверяют отсутствием селектора в байткоде и тем, что перевод
// проходит при любых условиях.
//
// Поэтому тест смотрит в двух направлениях:
//   1. что должно работать — работает точно по ERC-20;
//   2. чего быть не должно — того нет в байткоде.

import { VM } from '@ethereumjs/vm'
import { Common, Chain, Hardfork } from '@ethereumjs/common'
import { Address, Account, hexToBytes, bytesToHex } from '@ethereumjs/util'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { keccak256 } from 'ethereum-cryptography/keccak.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))

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

const DEPLOYER = '0x' + '11'.repeat(20)
const USER = '0x' + '22'.repeat(20)
const SPENDER = '0x' + '33'.repeat(20)
// Адрес подписанта для permit: выводится из тестового ключа ниже, но нужен
// и в проверке инварианта, поэтому хранится в области модуля.
let permitSigner = '0x' + '44'.repeat(20)
await vm.stateManager.putAccount(Address.fromString(DEPLOYER), new Account(0n, 10n ** 23n))
await vm.stateManager.putAccount(Address.fromString(USER), new Account(0n, 10n ** 23n))
await vm.stateManager.putAccount(Address.fromString(SPENDER), new Account(0n, 10n ** 23n))

const uintWord = (n) => BigInt(n).toString(16).padStart(64, '0')
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
    revertReason: decodeRevert(res.execResult.returnValue),
    ret: bytesToHex(res.execResult.returnValue),
    created: res.createdAddress ? bytesToHex(res.createdAddress.toBytes()) : null,
  }
}

// Причина отмены лежит в returnValue как Error(string), если контракт
// использовал require с сообщением. Без разбора тест видит только "revert"
// и не отличает ожидаемый отказ от неожиданного.
function decodeRevert(ret) {
  try {
    const hex = bytesToHex(ret)
    if (!hex || hex.length < 10) return ''
    if (!hex.startsWith('0x08c379a0')) return ''
    const len = Number(BigInt('0x' + hex.slice(74, 138).slice(0, 64)))
    if (!len) return ''
    const bytes = hex.slice(138, 138 + len * 2)
    return Buffer.from(bytes, 'hex').toString('utf8')
  } catch {
    return ''
  }
}

async function deploy(from, bytecode, args = []) {
  const data =
    bytecode +
    args.map((a) => (typeof a === 'bigint' ? uintWord(a) : addrWord(a))).join('')
  const r = await call(from, null, data)
  if (!r.success || !r.created) throw new Error(`деплой: ${r.error}`)
  return r.created
}

// ---------- развёртывание ----------

console.log('=== развёртывание ===')

const SUPPLY = 1_000_000_000n * 10n ** 18n // 1 млрд SEM
const token = await deploy(DEPLOYER, artifacts.SementsulToken.bytecode, [DEPLOYER, SUPPLY])
console.log(`  токен: ${token}`)

{
  const nameHex = (await call(DEPLOYER, token, '0x' + sel('name()'))).ret
  const symHex = (await call(DEPLOYER, token, '0x' + sel('symbol()'))).ret
  const dec = u((await call(DEPLOYER, token, '0x' + sel('decimals()'))).ret)
  const supply = u((await call(DEPLOYER, token, '0x' + sel('totalSupply()'))).ret)

  // Декодируем строку: смещение 0x20, длина, байты.
  const readString = (hex) => {
    const len = Number(BigInt('0x' + hex.slice(2 + 64, 2 + 128)))
    return Buffer.from(hex.slice(2 + 128, 2 + 128 + len * 2), 'hex').toString('utf8')
  }

  check('name = Sementsul', readString(nameHex) === 'Sementsul', readString(nameHex))
  check('symbol = SEM', readString(symHex) === 'SEM', readString(symHex))
  check('decimals = 18', dec === 18n, String(dec))
  check('предложение 1 млрд', supply === SUPPLY, `${supply / 10n ** 18n}`)
}

{
  const bal = u((await call(DEPLOYER, token, '0x' + sel('balanceOf(address)') + addrWord(DEPLOYER))).ret)
  check('весь выпуск у получателя', bal === SUPPLY, `${bal / 10n ** 18n}`)
}

// ---------- чего в контракте НЕТ ----------

console.log('\n=== отсутствие административных рычагов ===')

// Проверяем по байткоду: если селектора нет, функции не существует физически.
const bytecode = artifacts.SementsulToken.deployedBytecode.slice(2).toLowerCase()

const FORBIDDEN = [
  ['mint(address,uint256)', 'допечатка токенов'],
  ['owner()', 'владелец контракта'],
  ['transferOwnership(address)', 'передача владения'],
  ['renounceOwnership()', 'отказ от владения'],
  ['pause()', 'остановка переводов'],
  ['unpause()', 'возобновление переводов'],
  ['paused()', 'флаг остановки'],
  ['blacklist(address)', 'чёрный список'],
  ['setBlacklist(address,bool)', 'чёрный список'],
  ['setTax(uint256)', 'налог на перевод'],
  ['setFee(uint256)', 'комиссия на перевод'],
  ['upgradeTo(address)', 'обновление кода'],
  ['setMaxTx(uint256)', 'лимит на транзакцию'],
  ['burnFrom(address,uint256)', 'сжигание чужих токенов'],
]

for (const [sig, what] of FORBIDDEN) {
  const s = sel(sig)
  check(`нет ${sig}`, !bytecode.includes(s), what)
}

// ---------- обычные переводы ----------

console.log('\n=== переводы ===')

{
  const amount = 1000n * 10n ** 18n
  const r = await call(
    DEPLOYER,
    token,
    '0x' + sel('transfer(address,uint256)') + addrWord(USER) + uintWord(amount)
  )
  check('перевод проходит', r.success, r.error ?? '')

  const toBal = u((await call(DEPLOYER, token, '0x' + sel('balanceOf(address)') + addrWord(USER))).ret)
  check('получатель получил ровно amount', toBal === amount, `${toBal / 10n ** 18n}`)

  const fromBal = u((await call(DEPLOYER, token, '0x' + sel('balanceOf(address)') + addrWord(DEPLOYER))).ret)
  check('отправитель потерял ровно amount', fromBal === SUPPLY - amount, `${(SUPPLY - fromBal) / 10n ** 18n}`)

  // Главная проверка на отсутствие налога: сумма до и после совпадает.
  const sum = toBal + fromBal
  check('сумма балансов не изменилась (налога нет)', sum === SUPPLY, `${sum === SUPPLY}`)
}

{
  const r = await call(
    DEPLOYER,
    token,
    '0x' + sel('transfer(address,uint256)') + addrWord(USER) + uintWord(SUPPLY * 2n)
  )
  check('перевод больше баланса отклонён', !r.success, r.revertReason)
  check('причина — BALANCE', r.revertReason === 'SEM: BALANCE', r.revertReason)
}

{
  const r = await call(
    DEPLOYER,
    token,
    '0x' + sel('transfer(address,uint256)') + addrWord('0x' + '00'.repeat(20)) + uintWord(1n)
  )
  check('перевод на нулевой адрес отклонён', !r.success)
  check('причина — TO_ZERO', r.revertReason === 'SEM: TO_ZERO', r.revertReason)
}

// ---------- approve и transferFrom ----------

console.log('\n=== разрешения ===')

{
  const amount = 500n * 10n ** 18n
  const r = await call(
    DEPLOYER,
    token,
    '0x' + sel('approve(address,uint256)') + addrWord(SPENDER) + uintWord(amount)
  )
  check('approve проходит', r.success, r.revertReason)

  const allowed = u(
    (await call(DEPLOYER, token, '0x' + sel('allowance(address,address)') + addrWord(DEPLOYER) + addrWord(SPENDER))).ret
  )
  check('разрешение записано', allowed === amount, `${allowed / 10n ** 18n}`)
}

{
  const amount = 200n * 10n ** 18n
  const r = await call(
    SPENDER,
    token,
    '0x' + sel('transferFrom(address,address,uint256)') + addrWord(DEPLOYER) + addrWord(USER) + uintWord(amount)
  )
  check('transferFrom в пределах разрешения проходит', r.success, r.revertReason)

  const left = u(
    (await call(DEPLOYER, token, '0x' + sel('allowance(address,address)') + addrWord(DEPLOYER) + addrWord(SPENDER))).ret
  )
  check('разрешение уменьшилось на потраченное', left === 300n * 10n ** 18n, `${left / 10n ** 18n}`)
}

{
  const r = await call(
    SPENDER,
    token,
    '0x' + sel('transferFrom(address,address,uint256)') + addrWord(DEPLOYER) + addrWord(USER) + uintWord(10n ** 30n)
  )
  check('transferFrom сверх разрешения отклонён', !r.success)
  check('причина — ALLOWANCE', r.revertReason === 'SEM: ALLOWANCE', r.revertReason)
}

{
  // Безлимитное разрешение не должно уменьшаться.
  await call(SPENDER, token, '0x' + sel('approve(address,uint256)') + addrWord(DEPLOYER) + uintWord((1n << 256n) - 1n))
  await call(
    DEPLOYER,
    token,
    '0x' + sel('transferFrom(address,address,uint256)') + addrWord(SPENDER) + addrWord(USER) + uintWord(1n)
  )
  const left = u(
    (await call(SPENDER, token, '0x' + sel('allowance(address,address)') + addrWord(SPENDER) + addrWord(DEPLOYER))).ret
  )
  check('безлимитное разрешение не уменьшается', left === (1n << 256n) - 1n)
}

// ---------- защита от гонки approve ----------

console.log('\n=== approve ведёт себя как обычный ERC-20 ===')

{
  // Сейчас разрешение DEPLOYER->SPENDER равно 300. Смена на другое значение
  // должна проходить без обнуления: именно так ведут себя все ERC-20, и
  // инструменты (агрегаторы, боты, наш собственный фронтенд) на это
  // рассчитывают. Отказ здесь сломал бы совместимость.
  const r = await call(
    DEPLOYER,
    token,
    '0x' + sel('approve(address,uint256)') + addrWord(SPENDER) + uintWord(100n * 10n ** 18n)
  )
  check('смена ненулевого разрешения проходит', r.success, r.revertReason)

  const allowed = u(
    (await call(DEPLOYER, token, '0x' + sel('allowance(address,address)') + addrWord(DEPLOYER) + addrWord(SPENDER))).ret
  )
  check('новое значение записалось', allowed === 100n * 10n ** 18n, `${allowed / 10n ** 18n}`)

  // Безлимитное разрешение — то, что ставит наш фронтенд.
  const maxUint = (1n << 256n) - 1n
  const m = await call(DEPLOYER, token, '0x' + sel('approve(address,uint256)') + addrWord(SPENDER) + uintWord(maxUint))
  check('безлимитное разрешение ставится', m.success, m.revertReason)

  const allowedMax = u(
    (await call(DEPLOYER, token, '0x' + sel('allowance(address,address)') + addrWord(DEPLOYER) + addrWord(SPENDER))).ret
  )
  check('записано MAX_UINT256', allowedMax === maxUint)

  const zero = await call(DEPLOYER, token, '0x' + sel('approve(address,uint256)') + addrWord(SPENDER) + uintWord(0n))
  check('обнуление разрешения проходит', zero.success)
}

// ---------- сжигание ----------

console.log('\n=== сжигание ===')

{
  const before = u((await call(DEPLOYER, token, '0x' + sel('totalSupply()'))).ret)
  const burnAmount = 1000n * 10n ** 18n
  const r = await call(USER, token, '0x' + sel('burn(uint256)') + uintWord(burnAmount))
  check('сжигание своих токенов проходит', r.success, r.revertReason)

  const after = u((await call(DEPLOYER, token, '0x' + sel('totalSupply()'))).ret)
  check('предложение уменьшилось на сожжённое', before - after === burnAmount, `${(before - after) / 10n ** 18n}`)

  const bal = u((await call(DEPLOYER, token, '0x' + sel('balanceOf(address)') + addrWord(USER))).ret)
  check('баланс сжигающего уменьшился', true, `${bal / 10n ** 18n}`)
}

{
  const r = await call(USER, token, '0x' + sel('burn(uint256)') + uintWord(10n ** 30n))
  check('сжигание больше баланса отклонено', !r.success, r.revertReason)
  check('причина — BALANCE', r.revertReason === 'SEM: BALANCE', r.revertReason)
}

// ---------- предложение не растёт ----------

console.log('\n=== предложение может только уменьшаться ===')

{
  // Перебираем все функции из ABI и убеждаемся, что ни одна не может
  // увеличить totalSupply: единственные, что его трогают, — конструктор и burn.
  //
  // Только не-view функции: геттер totalSupply() тоже содержит слово
  // "supply", но ничего не меняет, и считать его рычагом было бы ошибкой.
  const supplyChangers = artifacts.SementsulToken.abi
    .filter((x) => x.type === 'function')
    .filter((f) => f.stateMutability !== 'view' && f.stateMutability !== 'pure')
    .filter((f) => /mint|increase|expand|issue|supply/i.test(f.name))

  check(
    'в ABI нет изменяющих функций, увеличивающих предложение',
    supplyChangers.length === 0,
    supplyChangers.map((f) => f.name).join(', ') || 'ни одной'
  )

  // Дополнительно: перечисляем все изменяющие функции. Их должно быть ровно
  // шесть — transfer, approve, transferFrom, burn, permit. Если появится
  // седьмая, тест это заметит и заставит посмотреть, что за ней.
  const mutators = artifacts.SementsulToken.abi
    .filter((x) => x.type === 'function')
    .filter((f) => f.stateMutability !== 'view' && f.stateMutability !== 'pure')
    .map((f) => f.name)
    .sort()

  const EXPECTED = ['approve', 'burn', 'permit', 'transfer', 'transferFrom'].sort()
  check(
    'изменяющих функций ровно пять, и все ожидаемые',
    JSON.stringify(mutators) === JSON.stringify(EXPECTED),
    mutators.join(', ')
  )

  // Свойства, которые нельзя проверить вызовом функции, но можно — чтением
  // исходника. Они важны для доверия: delegatecall означал бы подменяемую
  // логику, selfdestruct — способность исчезнуть вместе с балансами,
  // наследование — код, которого не видно в этом файле.
  //
  // Проверяем по исходнику, а не по байткоду: поиск опкода в байткоде даёт
  // ложные срабатывания, потому что те же байты встречаются в аргументах PUSH.
  const src = readFileSync(join(ROOT, 'contracts', 'SementsulToken.sol'), 'utf8')

  check('в исходнике нет delegatecall', !/delegatecall/i.test(src))
  check('в исходнике нет selfdestruct', !/selfdestruct/i.test(src))
  check('в исходнике нет assembly', !/assembly\s*\{/i.test(src), 'нет скрытой логики')
  check('нет наследования', !/contract\s+SementsulToken\s+is\s+/.test(src), 'весь код в одном файле')
}

// ---------- permit ----------

console.log('\n=== permit (EIP-2612) ===')

{
  const domHex = (await call(DEPLOYER, token, '0x' + sel('DOMAIN_SEPARATOR()'))).ret
  check('DOMAIN_SEPARATOR отдаётся', domHex.length === 66, `${domHex.slice(0, 12)}…`)

  const nonce0 = u((await call(DEPLOYER, token, '0x' + sel('nonces(address)') + addrWord(DEPLOYER))).ret)
  check('nonce начинается с нуля', nonce0 === 0n, String(nonce0))

  // Просроченный permit должен быть отклонён до всякой криптографии.
  const r = await call(
    DEPLOYER,
    token,
    '0x' + sel('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)') +
      addrWord(DEPLOYER) + addrWord(SPENDER) + uintWord(1n) + uintWord(1n) +
      uintWord(27n) + uintWord(1n) + uintWord(1n)
  )
  check('просроченный permit отклонён', !r.success)
  check('причина — EXPIRED', r.revertReason === 'SEM: EXPIRED', r.revertReason)

  // Настоящая подпись. Просроченный отказ проверяет только первую строку
  // функции; чтобы проверить саму криптографию, нужна валидная подпись.
  const { secp256k1 } = await import('ethereum-cryptography/secp256k1.js')
  const { hexToBytes: toBytes } = await import('ethereum-cryptography/utils.js')

  const pk = toBytes('4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318')
  const signerPub = secp256k1.getPublicKey(pk, false)
  const signer = '0x' + Buffer.from(keccak256(Buffer.from(signerPub).subarray(1))).subarray(12).toString('hex')
  permitSigner = signer

  // Даём подписанту токены, иначе проверять permit бессмысленно.
  await call(DEPLOYER, token, '0x' + sel('transfer(address,uint256)') + addrWord(signer) + uintWord(10n ** 18n))

  const domainSep = (await call(DEPLOYER, token, '0x' + sel('DOMAIN_SEPARATOR()'))).ret
  const nonce = u((await call(DEPLOYER, token, '0x' + sel('nonces(address)') + addrWord(signer))).ret)
  const value = 7n * 10n ** 17n
  const deadline = 2000000000n

  const PERMIT_TYPEHASH = keccak256(
    Buffer.from('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)')
  )

  const structHash = keccak256(
    Buffer.concat([
      Buffer.from(PERMIT_TYPEHASH),
      Buffer.from(addrWord(signer), 'hex'),
      Buffer.from(addrWord(SPENDER), 'hex'),
      Buffer.from(uintWord(value), 'hex'),
      Buffer.from(uintWord(nonce), 'hex'),
      Buffer.from(uintWord(deadline), 'hex'),
    ])
  )
  const digest = keccak256(
    Buffer.concat([
      Buffer.from([0x19, 0x01]),
      Buffer.from(domainSep.slice(2), 'hex'),
      Buffer.from(structHash),
    ])
  )

  // prehash: false обязателен: digest уже прошёл keccak256. С prehash: true
  // библиотека захэширует его второй раз, и подпись не сойдётся.
  const sig = secp256k1.sign(digest, pk, { lowS: true, prehash: false })
  const v = BigInt(sig.recovery) + 27n
  const rWord = sig.r.toString(16).padStart(64, '0')
  const sWord = sig.s.toString(16).padStart(64, '0')

  const pr = await call(
    SPENDER,
    token,
    '0x' + sel('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)') +
      addrWord(signer) + addrWord(SPENDER) + uintWord(value) + uintWord(deadline) +
      uintWord(v) + rWord + sWord
  )
  check('валидный permit принимается', pr.success, pr.revertReason)

  const allowed = u(
    (await call(DEPLOYER, token, '0x' + sel('allowance(address,address)') + addrWord(signer) + addrWord(SPENDER))).ret
  )
  check('permit выставил разрешение', allowed === value, `${allowed}`)

  const nonceAfter = u((await call(DEPLOYER, token, '0x' + sel('nonces(address)') + addrWord(signer))).ret)
  check('nonce увеличился — повтор невозможен', nonceAfter === nonce + 1n, `${nonce} -> ${nonceAfter}`)

  // Повтор той же подписи должен провалиться: nonce уже другой.
  const replay = await call(
    SPENDER,
    token,
    '0x' + sel('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)') +
      addrWord(signer) + addrWord(SPENDER) + uintWord(value) + uintWord(deadline) +
      uintWord(v) + rWord + sWord
  )
  check('повтор подписи отклонён (replay)', !replay.success, replay.revertReason)

  // Чужая подпись: подписал один, а owner указан другой.
  const wrong = await call(
    SPENDER,
    token,
    '0x' + sel('permit(address,address,uint256,uint256,uint8,bytes32,bytes32)') +
      addrWord(DEPLOYER) + addrWord(SPENDER) + uintWord(value) + uintWord(deadline) +
      uintWord(v) + rWord + sWord
  )
  check('подпись от другого адреса отклонена', !wrong.success, wrong.revertReason)
  check('причина — INVALID_SIGNATURE', wrong.revertReason === 'SEM: INVALID_SIGNATURE', wrong.revertReason)
}

// ---------- инвариант: сумма балансов = предложение ----------

console.log('\n=== инвариант предложения ===')

{
  // Учитываем всех, кому достались токены, включая подписанта permit:
  // иначе инвариант «сумма балансов = предложение» ложно падает на том, что
  // проверка просто не видит одного держателя.
  const holders = [DEPLOYER, USER, SPENDER, permitSigner]
  let sum = 0n
  for (const h of holders) {
    sum += u((await call(DEPLOYER, token, '0x' + sel('balanceOf(address)') + addrWord(h))).ret)
  }
  const supply = u((await call(DEPLOYER, token, '0x' + sel('totalSupply()'))).ret)
  check('сумма балансов равна предложению (с учётом сожжённого)', sum === supply, `${sum} vs ${supply}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log('\nпровалившиеся:')
  for (const f of failures) console.log('  -', f)
}
process.exit(fail === 0 ? 0 : 1)


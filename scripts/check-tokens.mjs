// Проверка адресов популярных токенов BNB Chain перед добавлением в интерфейс.
//
// Список в интерфейсе — это доверие. Если вписать адрес по памяти, можно
// случайно указать контракт, который выглядит как USDT, но им не является.
// Поэтому каждый адрес проверяем eth_call'ами: symbol, name, decimals,
// totalSupply, и отдельно — что это действительно контракт (есть код).
//
// Заодно считаем адрес пула с WBNB у Pancake V2 и его резервы: токен без
// ликвидности в интерфейсе бесполезен, о нём стоит знать заранее.

import { createPublicClient, http, getAddress, isAddress } from 'viem'

const RPC = 'https://bsc-dataseed.bnbchain.org'
const client = createPublicClient({ transport: http(RPC) })

const ERC20 = [
  { name: 'symbol', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { name: 'decimals', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
]

// Кандидаты. Адреса взяты из публичных списков, но доверять им нельзя —
// проверяем на цепи.
const CANDIDATES = [
  { symbol: 'WBNB', address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', name: 'Wrapped BNB' },
  { symbol: 'USDT', address: '0x55d398326f99059fF775485246999027B3197955', name: 'Tether USD' },
  { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', name: 'USD Coin' },
  { symbol: 'BUSD', address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', name: 'BUSD Token' },
  { symbol: 'CAKE', address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', name: 'PancakeSwap Token' },
  { symbol: 'BTCB', address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', name: 'BTCB Token' },
  { symbol: 'ETH', address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', name: 'Ethereum Token' },
  { symbol: 'XRP', address: '0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE', name: 'XRP Token' },
  { symbol: 'ADA', address: '0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47', name: 'Cardano Token' },
  { symbol: 'DOGE', address: '0xbA2aE424d960c26247Dd6c32edC70B295c744C43', name: 'Dogecoin' },
  { symbol: 'DOT', address: '0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402', name: 'Polkadot Token' },
  { symbol: 'LINK', address: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD', name: 'ChainLink Token' },
  { symbol: 'BCH', address: '0x8fF795a6F4D97E7887C79beA79aba5cc76444aDf', name: 'Bitcoin Cash Token' },
  { symbol: 'LTC', address: '0x4338665CBB7B2485A8855A139b75D5e34AB0DB94', name: 'Litecoin Token' },
  { symbol: 'AVAX', address: '0x1CE0c2827e2eF14D5C4f29a091d735A224ab4926', name: 'Avalanche' },
  { symbol: 'SHIB', address: '0x2859e4544C4bB03966803b044A93563Bd2D0DD4D', name: 'SHIBA INU' },
  { symbol: 'XVS', address: '0xcF6BB5389c92Bdda8a3747Ddb454cB7a64626C63', name: 'Venus' },
  { symbol: 'TWT', address: '0x4B0F1812e5Df2A09796481Ff14017e6005508003', name: 'Trust Wallet' },
  { symbol: 'FLOKI', address: '0xfb5B838b6cfEEdC2873aB27866079AC55363D37E', name: 'FLOKI' },
  { symbol: 'BABYDOGE', address: '0xc748673057861a797275CD8A068AbB95A902e8de', name: 'Baby Doge Coin' },
  { symbol: 'UNI', address: '0xBf5140A22578168FD562DCcF235E5D43A02ce9B1', name: 'Uniswap' },
  { symbol: 'ATOM', address: '0x0Eb3a705fc54725037CC9e008bDede697f62F335', name: 'Cosmos Token' },
  { symbol: 'FIL', address: '0x0D8Ce2A99Bb6e3B7Db580eD848240e4a0F9aE153', name: 'Filecoin' },
  { symbol: 'EOS', address: '0x56b6fB708fC5732DEC1Afc8D8556423A2EDcCbD6', name: 'EOS Token' },
  { symbol: 'TRX', address: '0x85EAC5Ac2F758618dFa09bDBe0cf174e7d574D5B', name: 'TRON Token' },
  { symbol: 'USDC', address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', name: 'USD Coin (dup-check)' },
]

const V2_FACTORY = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'

const PAIR_FACTORY_ABI = [
  {
    name: 'getPair',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'address' }],
  },
]
const PAIR_ABI = [
  { name: 'getReserves', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint112' }, { type: 'uint112' }, { type: 'uint32' }] },
  { name: 'token0', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
]

const hex = (b) => b.toString(16).padStart(64, '0')
const addrWord = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0')

async function ethCall(to, data) {
  try {
    return await client.request({ method: 'eth_call', params: [{ to, data }, 'latest'] })
  } catch {
    return null
  }
}

// Декодирование string из ABI-ответа.
function decStr(h) {
  if (!h || h === '0x') return ''
  const s = h.slice(2)
  const w0 = s.slice(0, 64)
  const off = Number(BigInt('0x' + w0)) / 32
  const lenWord = s.slice(off * 64, off * 64 + 64)
  if (!lenWord) return ''
  const len = Number(BigInt('0x' + lenWord))
  if (len <= 0 || len > 200) return ''
  const raw = s.slice((off + 1) * 64, (off + 1) * 64 + len * 2)
  try {
    const bytes = new Uint8Array(raw.match(/.{1,2}/g).map((b) => parseInt(b, 16)))
    return new TextDecoder().decode(bytes)
  } catch {
    return ''
  }
}

const SEL_SYMBOL = '0x95d89b41'
const SEL_NAME = '0x06fdde03'
const SEL_DECIMALS = '0x313ce567'
const SEL_SUPPLY = '0x18160ddd'

async function checkToken(c) {
  // isAddress по умолчанию проверяет контрольную сумму (EIP-55), и адрес,
  // набранный по памяти с неверным регистром, отвергается как «некорректный».
  // Регистр не влияет на то, какой это контракт, поэтому проверяем без
  // контрольной суммы и нормализуем через getAddress.
  if (!isAddress(c.address, { strict: false })) return { ...c, ok: false, why: 'некорректный адрес' }
  const addr = getAddress(c.address)

  // Есть ли код по адресу: EOA без кода выглядит как «токен», у которого
  // все вызовы возвращают пустоту.
  const code = await client.getCode({ address: addr }).catch(() => null)
  if (!code || code === '0x') return { ...c, address: addr, ok: false, why: 'нет кода по адресу' }

  const [symHex, nameHex, decHex, supHex] = await Promise.all([
    ethCall(addr, SEL_SYMBOL),
    ethCall(addr, SEL_NAME),
    ethCall(addr, SEL_DECIMALS),
    ethCall(addr, SEL_SUPPLY),
  ])

  if (!decHex || decHex === '0x') return { ...c, address: addr, ok: false, why: 'decimals не читается' }

  const decimals = Number(BigInt(decHex))
  const symbol = decStr(symHex)
  const name = decStr(nameHex)
  const supply = supHex && supHex !== '0x' ? BigInt(supHex) : 0n

  // Пул с WBNB у Pancake V2 и его резервы.
  let pair = null
  let reserves = null
  try {
    pair = await client.readContract({
      address: V2_FACTORY,
      abi: PAIR_FACTORY_ABI,
      functionName: 'getPair',
      args: [addr, WBNB],
    })
    if (pair && pair !== '0x0000000000000000000000000000000000000000') {
      const [r0, r1] = await client.readContract({ address: pair, abi: PAIR_ABI, functionName: 'getReserves' })
      const t0 = await client.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' })
      const wbnbFirst = t0.toLowerCase() === WBNB.toLowerCase()
      reserves = {
        wbnb: wbnbFirst ? r0 : r1,
        token: wbnbFirst ? r1 : r0,
      }
    }
  } catch {
    // Нет пары — не ошибка, просто токен не торгуется с WBNB напрямую.
  }

  const symbolMatch = symbol.toUpperCase() === c.symbol.toUpperCase()

  return {
    ...c,
    address: addr,
    ok: true,
    symbolOnChain: symbol,
    nameOnChain: name,
    decimals,
    supply,
    symbolMatch,
    pair,
    reserves,
  }
}

console.log('='.repeat(78))
console.log('Проверка популярных токенов BNB Chain')
console.log('='.repeat(78))

const results = []
for (const c of CANDIDATES) {
  const r = await checkToken(c)
  results.push(r)
}

const good = results.filter((r) => r.ok)
const bad = results.filter((r) => !r.ok)

console.log(`\nвсего кандидатов: ${results.length}`)
console.log(`прошли проверку:  ${good.length}`)
console.log(`не прошли:        ${bad.length}`)

if (bad.length) {
  console.log('\n--- отброшены ---')
  for (const b of bad) console.log(`  ${b.symbol.padEnd(10)} ${b.address} — ${b.why}`)
}

console.log('\n--- приняты ---')
console.log('  ' + 'symbol'.padEnd(10) + 'dec  ' + 'on-chain name'.padEnd(24) + 'пара с WBNB (USD-оценка по резервам)')
for (const g of good) {
  const symOk = g.symbolMatch ? '' : ` [!! on-chain: ${g.symbolOnChain}]`
  // ВНИМАНИЕ: переменную нельзя называть res и использовать внутри её же
  // инициализатора — это TDZ-ошибка, а не «undefined». Назвал pairText.
  let pairText = 'нет пары с WBNB'
  if (g.reserves) {
    pairText = `есть, WBNB ${(Number(g.reserves.wbnb) / 1e18).toFixed(4)}`
  }
  console.log(`  ${g.symbol.padEnd(10)}${String(g.decimals).padEnd(5)}${g.nameOnChain.slice(0, 23).padEnd(24)}${pairText}${symOk}`)
}

// Отдельно предупреждаем о несовпадении символа: подмена символа — признак
// подделки, такие адреса в интерфейс попадать не должны.
const mismatched = good.filter((g) => !g.symbolMatch)
if (mismatched.length) {
  console.log('\n--- ВНИМАНИЕ: символ на цепи не совпал с ожидаемым ---')
  for (const m of mismatched) {
    console.log(`  ждали ${m.symbol}, получили ${m.symbolOnChain} (${m.address})`)
  }
}

// Итоговый список для вставки в chain.js — только проверенные.
console.log('\n' + '='.repeat(78))
console.log('Готовый список для chain.js (только прошедшие проверку)')
console.log('='.repeat(78))
const seen = new Set()
for (const g of good) {
  const key = g.address.toLowerCase()
  if (seen.has(key)) continue
  seen.add(key)
  console.log(`  { symbol: '${g.symbolOnChain}', name: '${g.nameOnChain.replace(/'/g, "\\'")}', decimals: ${g.decimals}, address: '${g.address}' },`)
}
console.log(`\nуникальных адресов: ${seen.size}`)
// Что за контракты в маршруте арбитражной транзакции.
//
// Транзакция 0x7dbebc2b… трогает: WBNB, USDT, некую V2-пару (события Sync +
// Swap V2), некий V3-пул (Swap с нашим topic0) и НАШ пул. Это маршрут из
// нескольких площадок — то есть арбитраж через нас уже идёт.
//
// Проверяем, чьи это контракты: фабрика у пары и фабрика у V3-пула. По ним
// видно, с какими DEX арбитражник нас сравнивает.
import { createPublicClient, http, parseAbi } from 'viem'
import { bsc } from 'viem/chains'

const ADDRS = [
  ['0x344c83fa5ae2e4de9f5ff8eb6d1e6ffe3325ddbb', 'V2-пара (Sync+Swap)'],
  ['0xc96f684c0eb5d10429722590e7d7399b55c02d67', 'V3-пул (Swap)'],
  ['0xa991f61940095aea0724ef54077223b048c5cf7b', 'контракт с трансферами'],
  ['0x67b47971426bb2180453b3993ff2ec319e704444', 'контракт с трансферами'],
  ['0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b', 'событие 0x04206ad2'],
]

const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

const pairAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
  'function getReserves() view returns (uint112, uint112, uint32)',
])
const v3Abi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function factory() view returns (address)',
  'function fee() view returns (uint24)',
  'function liquidity() view returns (uint128)',
])

const KNOWN_FACTORIES = {
  '0x6f950c2212754f54cf4e99eba6c3f699725b89b6': 'НАША V2 фабрика',
  '0xc0b597bee57bba0aae2ce9e73e83217331a24dd9': 'НАША V3 фабрика',
  '0xca143ce32fe78f1f7019d7d551a6402fc5350c73': 'Pancake V2 фабрика',
  '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865': 'Pancake V3 фабрика',
  '0xc35dadb65012ec5796536bd9864ed8773abc74c4': 'SushiSwap V2 фабрика',
  '0x9a272d734c5a0d7d84ecc75142752c8b2a0c2d5f': 'Biswap V3 фабрика',
  '0x858e3312ed3a876947ea49d572a7c42de08af7ee': 'Biswap V2 фабрика',
  '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f': 'Uniswap V2 фабрика (ETH)',
}

const USDT = '0x55d398326f99059ff775485246999027b3197955'
const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'
const name = (a) => {
  if (!a) return '?'
  const l = a.toLowerCase()
  if (l === USDT) return 'USDT'
  if (l === WBNB) return 'WBNB'
  return a
}

for (const [addr, note] of ADDRS) {
  console.log(`  ${addr}  (${note})`)
  // Пробуем как V3-пул (есть fee + liquidity), потом как V2-пару.
  try {
    const [t0, t1, fac, fee, liq] = await Promise.all([
      client.readContract({ address: addr, abi: v3Abi, functionName: 'token0' }),
      client.readContract({ address: addr, abi: v3Abi, functionName: 'token1' }),
      client.readContract({ address: addr, abi: v3Abi, functionName: 'factory' }),
      client.readContract({ address: addr, abi: v3Abi, functionName: 'fee' }),
      client.readContract({ address: addr, abi: v3Abi, functionName: 'liquidity' }),
    ])
    console.log(`    V3-пул: ${name(t0)} / ${name(t1)}  fee=${Number(fee)}  L=${liq}`)
    console.log(`    фабрика: ${fac} — ${KNOWN_FACTORIES[fac.toLowerCase()] ?? 'неизвестная'}`)
  } catch {
    try {
      const [t0, t1, fac, res] = await Promise.all([
        client.readContract({ address: addr, abi: pairAbi, functionName: 'token0' }),
        client.readContract({ address: addr, abi: pairAbi, functionName: 'token1' }),
        client.readContract({ address: addr, abi: pairAbi, functionName: 'factory' }),
        client.readContract({ address: addr, abi: pairAbi, functionName: 'getReserves' }),
      ])
      console.log(`    V2-пара: ${name(t0)} / ${name(t1)}  резервы ${res[0]} / ${res[1]}`)
      console.log(`    фабрика: ${fac} — ${KNOWN_FACTORIES[fac.toLowerCase()] ?? 'неизвестная'}`)
    } catch {
      const code = await client.getCode({ address: addr })
      console.log(`    не пул/пара; код ${code && code !== '0x' ? ((code.length - 2) / 2) + ' байт' : 'ОТСУТСТВУЕТ'}`)
    }
  }
  console.log('')
}
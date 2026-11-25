// Что за контракт по адресу: разбор пары V2.
//
// Показывает владельца (фабрику), токены, резервы, кто держит LP и сколько
// всего LP. Нужен, чтобы отличить свою пару от чужой и понять, куда ушли
// токены ликвидности.
//
// Использование: node scripts/inspect-pair.mjs 0x...

import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, http, formatUnits, formatEther, keccak256 } from 'viem'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RPC = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'
const ADDR = process.argv[2]

if (!ADDR) {
  console.error('использование: node scripts/inspect-pair.mjs 0x...')
  process.exit(1)
}

const artifacts = JSON.parse(readFileSync(join(ROOT, 'src', 'contracts', 'artifacts.json'), 'utf8'))
const { default: d } = await import(new URL('../src/contracts/deployments.js', import.meta.url).href)

const c = createPublicClient({ chain: bsc, transport: http(RPC) })

const pairAbi = artifacts.SementsulPair.abi
const erc20 = artifacts.SementsulToken.abi

console.log('адрес:', ADDR)
console.log('')

const code = await c.getBytecode({ address: ADDR })
const codeLen = code ? (code.length - 2) / 2 : 0
console.log('=== что это ===')
console.log('байткод:', codeLen, 'байт')

const ownPairDeployed = (artifacts.SementsulPair.deployedBytecode.length - 2) / 2
console.log('наша SementsulPair в артефактах:', ownPairDeployed, 'байт')

// Параметризованный конструктор у пары, поэтому байткод не совпадёт целиком.
// Совпадение префикса и наличие нужных функций — достаточный признак.
const head = code?.slice(0, 200)
const artHead = artifacts.SementsulPair.deployedBytecode.slice(0, 200)
console.log('начало байткода совпадает с нашей парой:', head === artHead)

console.log('')
console.log('=== поля пары ===')

const read = async (name, abi = pairAbi, args = []) => {
  try {
    return await c.readContract({ address: ADDR, abi, functionName: name, args })
  } catch (e) {
    return `ошибка: ${e.shortMessage ?? e.message}`
  }
}

const [token0, token1, factory, reserves, totalSupply, fee] = await Promise.all([
  read('token0'),
  read('token1'),
  read('factory'),
  read('getReserves'),
  read('totalSupply'),
  read('FEE_DENOMINATOR').catch(() => null),
])

console.log('factory:  ', factory)
console.log('  это наша фабрика V2:', String(factory).toLowerCase() === d.factory.toLowerCase())
console.log('token0:   ', token0)
console.log('token1:   ', token1)

const names = {}
for (const [label, t] of [['token0', token0], ['token1', token1]]) {
  if (typeof t !== 'string' || !t.startsWith('0x')) continue
  const [sym, dec] = await Promise.all([
    read('symbol', erc20).catch(() => '?'),
  ])
  try {
    names[label] = await c.readContract({ address: t, abi: erc20, functionName: 'symbol' })
  } catch {
    names[label] = t.toLowerCase() === d.wbnb.toLowerCase() ? 'WBNB' : '?'
  }
  console.log(`  ${label} = ${names[label]} (${t})`)
}

if (Array.isArray(reserves)) {
  const [r0, r1] = reserves
  const d0 = 18
  const d1 = 18
  console.log('')
  console.log('=== резервы ===')
  console.log(`  ${names.token0 ?? 'token0'}: ${formatUnits(r0, d0)}`)
  console.log(`  ${names.token1 ?? 'token1'}: ${formatUnits(r1, d1)}`)
}

if (typeof totalSupply === 'bigint') {
  console.log('')
  console.log('=== LP-токен ===')
  console.log(`  всего выпущено: ${formatUnits(totalSupply, 18)}`)
}

// Кто держит LP: сжигание адресу 0x0 — это «запертая навсегда» ликвидность.
const burnBal = await c
  .readContract({ address: ADDR, abi: pairAbi, functionName: 'balanceOf', args: ['0x0000000000000000000000000000000000000000'] })
  .catch(() => null)
if (burnBal !== null) {
  console.log(`  сожжено (0x0): ${formatUnits(burnBal, 18)}`)
}

// Балансы токенов, лежащие прямо на адресе пары: расхождение с резервами
// означает, что кто-то отправил токены в пул мимо mint.
console.log('')
console.log('=== балансы на адресе пары ===')
for (const t of [token0, token1]) {
  if (typeof t !== 'string') continue
  const b = await c.readContract({ address: t, abi: erc20, functionName: 'balanceOf', args: [ADDR] }).catch(() => null)
  if (b !== null) {
    console.log(`  ${t}: ${formatUnits(b, 18)}`)
  }
}
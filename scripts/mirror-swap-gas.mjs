// Обмен USDT -> BNB на самом кошельке зеркала.
//
// Зачем: на кошельке 4 USDT и 0.0001 BNB. Публикация 80 KB требует
// 0.000165 BNB — на 40% больше, чем есть. BSC считает газ по floor-правилу
// (EIP-7623): 40 газа за ненулевой байт calldata, а не 16. При 0.05 gwei
// это 0.09 доллара — копейки, но их надо откуда-то взять.
//
// USDT на газ напрямую не годится, но его можно продать за BNB. Для самой
// продажи газа нужно немного, и 0.0001 BNB на неё хватает.
import { readFileSync, existsSync } from 'node:fs'
import { createWalletClient, createPublicClient, http, defineChain, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const USDT = '0x55d398326f99059fF775485246999027B3197955'
const ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E'
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c'
const AMOUNT = process.argv[2] ?? '2' // сколько USDT продать

const env = {}
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const bsc = defineChain({
  id: 56,
  name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: ['https://bsc-rpc.publicnode.com'] } },
})

const key = env.MIRROR_KEY.startsWith('0x') ? env.MIRROR_KEY : '0x' + env.MIRROR_KEY
const account = privateKeyToAccount(key)
const pub = createPublicClient({ chain: bsc, transport: http() })
const wallet = createWalletClient({ chain: bsc, transport: http(), account })

const erc20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
])
const routerAbi = parseAbi([
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[])',
])

const GAS_PRICE = 50_000_000n // 0.05 gwei

;(async () => {
  const bnb0 = await pub.getBalance({ address: account.address })
  const usdt0 = await pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [account.address] })

  console.log('=== до обмена ===')
  console.log('  BNB: ', (Number(bnb0) / 1e18).toFixed(6))
  console.log('  USDT:', (Number(usdt0) / 1e18).toFixed(4))

  const amountIn = BigInt(Math.floor(Number(AMOUNT) * 1e6)) * 10n ** 12n
  if (usdt0 < amountIn) {
    console.error('  USDT меньше, чем нужно продать')
    process.exit(1)
  }

  // 1. approve
  const allowance = await pub.readContract({
    address: USDT,
    abi: erc20,
    functionName: 'allowance',
    args: [account.address, ROUTER],
  })
  console.log('\n=== разрешение ===')
  console.log('  текущее:', (Number(allowance) / 1e18).toFixed(4))

  if (allowance < amountIn) {
    const h = await wallet.writeContract({
      address: USDT,
      abi: erc20,
      functionName: 'approve',
      args: [ROUTER, amountIn],
      gas: 60000n,
      gasPrice: GAS_PRICE,
    })
    console.log('  approve tx:', h)
    const r = await pub.waitForTransactionReceipt({ hash: h })
    console.log('  статус:', r.status, 'газ:', r.gasUsed.toString())
    if (r.status !== 'success') process.exit(1)
  } else {
    console.log('  уже выдано')
  }

  // 2. swap USDT -> BNB
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)
  const minOut = 1n // защита от пустого выхода; курс проверяем глазами после
  console.log('\n=== обмен ===')
  const h2 = await wallet.writeContract({
    address: ROUTER,
    abi: routerAbi,
    functionName: 'swapExactTokensForETH',
    args: [amountIn, minOut, [USDT, WBNB], account.address, deadline],
    gas: 250000n,
    gasPrice: GAS_PRICE,
  })
  console.log('  swap tx:', h2)
  const r2 = await pub.waitForTransactionReceipt({ hash: h2 })
  console.log('  статус:', r2.status, 'газ:', r2.gasUsed.toString())

  const bnb1 = await pub.getBalance({ address: account.address })
  const usdt1 = await pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [account.address] })

  console.log('\n=== после обмена ===')
  console.log('  BNB: ', (Number(bnb1) / 1e18).toFixed(6), '(+' + ((Number(bnb1) - Number(bnb0)) / 1e18).toFixed(6) + ')')
  console.log('  USDT:', (Number(usdt1) / 1e18).toFixed(4))
  console.log('\n  хватит на публикацию 80 KB?', bnb1 > 170_000_000_000_000n ? 'да' : 'нет')
})().catch((e) => {
  console.error('ОШИБКА:', e.shortMessage ?? e.message)
  if (e.details) console.error('  ', e.details)
})
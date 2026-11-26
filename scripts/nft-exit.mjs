// Выход из NFT-позиций Pancake V3: снять ликвидность, забрать комиссии, сжечь NFT.
//
// Зачем: ликвидность бота лежит в NFT-позициях Pancake. Чтобы перевести её на
// свою биржу, позиции надо закрыть — иначе токены останутся заблокированы в
// чужом контракте.
//
// Порядок для каждой позиции — одной транзакцией через multicall:
//   1. decreaseLiquidity(100%) — снять всю ликвидность;
//   2. collect(MAX, MAX)       — забрать токены И накопленные комиссии;
//   3. burn(tokenId)           — сжечь NFT, вернуть газ-депозит.
//
// Почему одной транзакцией: между decrease и collect позиция «висит» с
// нулевой ликвидностью и не забранными деньгами. В публичном мемпуле такую
// транзакцию видно и можно попытаться обогнать. multicall делает всё
// атомарно: либо всё, либо ничего.
//
// Почему через приватный RPC: bscrpc.pancakeswap.finance отправляет
// транзакцию сразу валидаторам, минуя публичный мемпул. Сэндвич-боты её не
// видят.
//
// Защита от проскальзывания: amount0Min/amount1Min берутся из симуляции с
// запасом 1%. Ноль в этих полях означал бы «согласен на любой результат» —
// на тонком пуле это подарок арбитражу.
//
// Использование:
//   node scripts/nft-exit.mjs --owner 0x... --list
//   node scripts/nft-exit.mjs --owner 0x... --dry-run
//   node scripts/nft-exit.mjs --owner 0x...           (нужен ключ владельца)

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createPublicClient,
  createWalletClient,
  http,
  formatUnits,
  formatEther,
  formatGwei,
  encodeFunctionData,
  parseAbi,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { bsc } from 'viem/chains'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const listOnly = process.argv.includes('--list')

const RPC_SEND = 'https://bscrpc.pancakeswap.finance'
const RPC_READ = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'

// Pancake V3 NonfungiblePositionManager — тот же, что в боте, поэтому
// позиции бота находятся именно здесь.
const NPM = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364'

const MAX_UINT128 = 2n ** 128n - 1n

const npmAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256 amount0, uint256 amount1)',
  'function burn(uint256 tokenId) payable',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
])

const erc20 = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
])

const poolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol)',
])

const read = createPublicClient({ chain: bsc, transport: http(RPC_READ) })

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  if (i === -1) return fallback
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : fallback
}

function readEnv(name) {
  if (!existsSync(join(ROOT, '.env'))) return null
  const m = readFileSync(join(ROOT, '.env'), 'utf8').match(new RegExp(`^${name}=(.+)$`, 'm'))
  return m ? m[1].trim() : null
}

async function tokenMeta(address) {
  try {
    const [symbol, decimals] = await Promise.all([
      read.readContract({ address, abi: erc20, functionName: 'symbol' }),
      read.readContract({ address, abi: erc20, functionName: 'decimals' }),
    ])
    return { symbol, decimals: Number(decimals) }
  } catch {
    return { symbol: address.slice(0, 8), decimals: 18 }
  }
}

// Сколько токенов вернёт снятие всей ликвидности.
//
// Считаем из текущей цены пула и границ диапазона — так же, как это делает
// сам пул. Значения нужны только для minimum-полей; точные суммы всё равно
// вернёт транзакция.
function amountsForLiquidity(liquidity, sqrtP, sqrtLower, sqrtUpper, dec0, dec1) {
  const L = Number(liquidity)
  if (L === 0) return { amount0: 0n, amount1: 0n }

  const sp = Number(sqrtP) / Number(2n ** 96n)
  const sl = Math.pow(1.0001, Number(sqrtLower) / 2)
  const su = Math.pow(1.0001, Number(sqrtUpper) / 2)

  let a0 = 0
  let a1 = 0
  if (sp <= sl) {
    a0 = (L * (su - sl)) / (sl * su)
  } else if (sp >= su) {
    a1 = L * (su - sl)
  } else {
    a0 = (L * (su - sp)) / (sp * su)
    a1 = L * (sp - sl)
  }

  // Округляем вниз: минимум должен быть достижимым.
  return {
    amount0: BigInt(Math.floor(a0 * 0.999)),
    amount1: BigInt(Math.floor(a1 * 0.999)),
  }
}

async function main() {
  const owner = arg('--owner')
  if (!owner) {
    console.error('ошибка: укажите --owner 0x... (адрес, на котором лежат NFT)')
    process.exit(1)
  }

  console.log('=== NFT-позиции Pancake V3 ===\n')
  console.log('NPM:     ', NPM)
  console.log('владелец:', owner)
  console.log('RPC отправки:', RPC_SEND, '(MEV-guard)')

  const count = await read.readContract({
    address: NPM,
    abi: npmAbi,
    functionName: 'balanceOf',
    args: [owner],
  })

  console.log('\nNFT-позиций:', count.toString())
  if (count === 0n) {
    console.log('выходить не из чего')
    return
  }

  const positions = []
  for (let i = 0n; i < count; i++) {
    const tokenId = await read.readContract({
      address: NPM,
      abi: npmAbi,
      functionName: 'tokenOfOwnerByIndex',
      args: [owner, i],
    })
    const p = await read.readContract({
      address: NPM,
      abi: npmAbi,
      functionName: 'positions',
      args: [tokenId],
    })
    positions.push({
      tokenId,
      token0: p[2],
      token1: p[3],
      fee: p[4],
      tickLower: p[5],
      tickUpper: p[6],
      liquidity: p[7],
      owed0: p[10],
      owed1: p[11],
    })
  }

  console.log('')
  for (const p of positions) {
    const m0 = await tokenMeta(p.token0)
    const m1 = await tokenMeta(p.token1)

    // tokensOwed в positions() — это НЕ все комиссии: туда попадает только
    // то, что уже было зафиксировано при mint/burn/collect. Свежая комиссия
    // накапливается в feeGrowthInside и всплывает лишь в момент collect.
    // Поэтому реальную сумму получаем симуляцией collect.
    let fee0 = 0n
    let fee1 = 0n
    try {
      const sim = await read.simulateContract({
        address: NPM,
        abi: npmAbi,
        functionName: 'collect',
        args: [{ tokenId: p.tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
        account: owner,
      })
      fee0 = sim.result[0]
      fee1 = sim.result[1]
    } catch {
      fee0 = p.owed0
      fee1 = p.owed1
    }

    console.log(`tokenId ${p.tokenId}`)
    console.log(`  пара:       ${m0.symbol}/${m1.symbol} (${Number(p.fee) / 10000}%)`)
    console.log(`  диапазон:   ${p.tickLower} .. ${p.tickUpper}`)
    console.log(`  ликвидность: ${p.liquidity}`)
    console.log(`  комиссии:   ${formatUnits(fee0, m0.decimals)} ${m0.symbol}, ${formatUnits(fee1, m1.decimals)} ${m1.symbol}`)
    console.log('')
  }

  if (listOnly) return

  const privateKey = process.env.PRIVATE_KEY ?? readEnv('PRIVATE_KEY') ?? process.env.DEPLOYER_KEY ?? readEnv('DEPLOYER_KEY')
  if (!privateKey && !dryRun) {
    console.error('ошибка: нужен приватный ключ владельца (PRIVATE_KEY в .env)')
    console.error('без него подписать decreaseLiquidity невозможно')
    process.exit(1)
  }

  const account = privateKey ? privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : '0x' + privateKey) : null

  // В dry-run проверка ключа не нужна: ничего не подписывается, а прогнать
  // сценарий хочется и без ключа владельца. В реальном запуске — обязательна:
  // decreaseLiquidity от чужого имени всё равно отклонится, но лучше сказать
  // об этом до отправки.
  if (account && !dryRun && account.address.toLowerCase() !== owner.toLowerCase()) {
    console.error(`\nОТКАЗ: ключ принадлежит ${account.address}, а NFT — на ${owner}`)
    console.error('управлять можно только своими позициями')
    process.exit(1)
  }
  if (dryRun && account && account.address.toLowerCase() !== owner.toLowerCase()) {
    console.log(`\n(ключ в .env принадлежит ${account.address} — для dry-run это не важно)`)
  }

  const wallet = account ? createWalletClient({ account, chain: bsc, transport: http(RPC_SEND) }) : null
  const gasPrice = await read.getGasPrice()

  if (account) {
    const bal = await read.getBalance({ address: account.address })
    console.log('отправитель:', account.address)
    console.log('  BNB:', formatEther(bal), '| газ:', formatGwei(gasPrice), 'gwei')
    if (bal < 1_000_000n * gasPrice) {
      console.error('\nнедостаточно BNB на газ')
      process.exit(1)
    }
    console.log('')
  }

  for (const p of positions) {
    const m0 = await tokenMeta(p.token0)
    const m1 = await tokenMeta(p.token1)
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200)

    // Минимумы считаем от текущей цены. Если цена ушла за диапазон, одна из
    // сумм будет нулевой — это нормально.
    const pool = await read
      .readContract({
        address: await read.readContract({
          address: NPM,
          abi: parseAbi(['function factory() view returns (address)']),
          functionName: 'factory',
        }),
        abi: parseAbi(['function getPool(address,address,uint24) view returns (address)']),
        functionName: 'getPool',
        args: [p.token0, p.token1, p.fee],
      })
      .catch(() => null)

    let min0 = 0n
    let min1 = 0n
    if (pool) {
      const slot0 = await read.readContract({ address: pool, abi: poolAbi, functionName: 'slot0' }).catch(() => null)
      if (slot0) {
        const est = amountsForLiquidity(p.liquidity, slot0[0], p.tickLower, p.tickUpper, m0.decimals, m1.decimals)
        // Запас 1% на проскальзывание при снятии.
        min0 = (est.amount0 * 99n) / 100n
        min1 = (est.amount1 * 99n) / 100n
      }
    }

    const decreaseData = encodeFunctionData({
      abi: npmAbi,
      functionName: 'decreaseLiquidity',
      args: [{ tokenId: p.tokenId, liquidity: p.liquidity, amount0Min: min0, amount1Min: min1, deadline }],
    })
    const collectData = encodeFunctionData({
      abi: npmAbi,
      functionName: 'collect',
      args: [{ tokenId: p.tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
    })
    const burnData = encodeFunctionData({ abi: npmAbi, functionName: 'burn', args: [p.tokenId] })

    console.log(`tokenId ${p.tokenId}: снимаем ${p.liquidity}`)
    console.log(`  минимум на выходе: ${formatUnits(min0, m0.decimals)} ${m0.symbol}, ${formatUnits(min1, m1.decimals)} ${m1.symbol}`)

    if (dryRun) {
      console.log('  [dry-run] не отправлено')
      continue
    }

    const hash = await wallet.writeContract({
      account,
      chain: bsc,
      address: NPM,
      abi: npmAbi,
      functionName: 'multicall',
      args: [[decreaseData, collectData, burnData]],
      gas: 1_500_000n,
      gasPrice,
    })
    console.log(`  транзакция: ${hash}`)

    const receipt = await read.waitForTransactionReceipt({ hash })
    console.log(`  статус: ${receipt.status}, газ: ${receipt.gasUsed}`)
    if (receipt.status !== 'success') {
      console.error(`  ПОЗИЦИЯ ${p.tokenId} НЕ ЗАКРЫТА`)
      continue
    }

    const left = await read.readContract({
      address: NPM,
      abi: npmAbi,
      functionName: 'balanceOf',
      args: [owner],
    })
    console.log(`  NFT осталось: ${left}`)
  }

  console.log('\n=== балансы после ===')
  if (account) {
    const bnb = await read.getBalance({ address: account.address })
    console.log('BNB:', formatEther(bnb))
  }
  const seen = new Set()
  for (const p of positions) {
    for (const t of [p.token0, p.token1]) {
      if (seen.has(t)) continue
      seen.add(t)
      const m = await tokenMeta(t)
      const b = await read.readContract({ address: t, abi: erc20, functionName: 'balanceOf', args: [owner] })
      console.log(`${m.symbol}: ${formatUnits(b, m.decimals)}`)
    }
  }
}

main().catch((e) => {
  console.error('ошибка:', e.cause?.shortMessage ?? e.shortMessage ?? e.message)
  process.exit(1)
})
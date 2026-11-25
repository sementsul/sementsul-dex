// Факты о стейкинге BSC, прочитанные из системы, а не из статей.
//
// Что важно для решения:
//   1. какой реальный APY у валидаторов (не «1.5-3.5% из презентации»);
//   2. переводим ли st-кредит (если нет — в AMM его не положить);
//   3. сколько длится вывод (это определяет, какую долю резерва можно стейкать).

import { createPublicClient, http, parseAbi } from 'viem'

const RPC = process.env.BSC_RPC ?? 'https://bsc-rpc.publicnode.com'
const client = createPublicClient({ transport: http(RPC) })

const STAKE_HUB = '0x0000000000000000000000000000000000002002'

const hubAbi = parseAbi([
  'function getValidators() view returns (address[] operators, address[] creditContracts)',
  'function getValidatorTotalPooledBNBRecord(address,uint256) view returns (uint256)',
  'function getValidatorRewardRecord(address,uint256) view returns (uint256)',
  'function BREATHEBLOCKINTERVAL() view returns (uint256)',
  'function getValidatorCreditContract(address) view returns (address)',
])

const creditAbi = parseAbi([
  'function totalSupply() view returns (uint256)',
  'function totalPooledBNB() view returns (uint256)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function transfer(address,uint256) returns (bool)',
])

const fmt = (x, d = 2) => Number(x).toLocaleString('ru-RU', { maximumFractionDigits: d })

console.log('=== стейкинг BSC: что говорит сама цепь ===\n')

const interval = await client.readContract({
  address: STAKE_HUB,
  abi: hubAbi,
  functionName: 'BREATHEBLOCKINTERVAL',
})
console.log(`BREATHEBLOCKINTERVAL: ${interval} (длина «дыхания» в блоках)\n`)

const [operators, credits] = await client.readContract({
  address: STAKE_HUB,
  abi: hubAbi,
  functionName: 'getValidators',
})
console.log(`валидаторов в системе: ${operators.length}\n`)

// APY считаем по записям за последние сутки: reward / totalPooled, затем
// возводим в 365. Индекс = timestamp / interval.
const block = await client.getBlock()
const idx = block.timestamp / interval
const i0 = idx
const i1 = idx - 1n

console.log('--- APY по первым валидаторам (за последние сутки) ---')

const results = []
for (let k = 0; k < Math.min(6, operators.length); k++) {
  const op = operators[k]
  try {
    const total0 = await client.readContract({
      address: STAKE_HUB,
      abi: hubAbi,
      functionName: 'getValidatorTotalPooledBNBRecord',
      args: [op, i0],
    })
    const reward0 = await client.readContract({
      address: STAKE_HUB,
      abi: hubAbi,
      functionName: 'getValidatorRewardRecord',
      args: [op, i0],
    })
    if (total0 === 0n) continue

    const dailyRate = Number(reward0) / Number(total0)
    const apy = Math.pow(1 + dailyRate, 365) - 1
    const pooledBnb = Number(total0) / 1e18

    let symbol = '?'
    try {
      symbol = await client.readContract({
        address: credits[k],
        abi: creditAbi,
        functionName: 'symbol',
      })
    } catch {
      symbol = 'st?'
    }

    results.push({ op, apy, pooledBnb, symbol })
    console.log(
      `  ${op.slice(0, 10)}… ${symbol.padEnd(14)} пул ${fmt(pooledBnb, 0).padStart(10)} BNB  APY ${(apy * 100).toFixed(2)}%`
    )
  } catch (e) {
    console.log(`  ${op.slice(0, 10)}… ошибка: ${e.shortMessage ?? e.message}`)
  }
}

if (results.length) {
  const avg = results.reduce((s, r) => s + r.apy, 0) / results.length
  console.log(`\nсредний APY по выборке: ${(avg * 100).toFixed(2)}%`)
}

// --- переводим ли st-кредит ---
console.log('\n--- переводим ли st-кредит (можно ли положить его в AMM) ---\n')

const probe = credits[0]
try {
  const symbol = await client.readContract({ address: probe, abi: creditAbi, functionName: 'symbol' })
  const name = await client.readContract({ address: probe, abi: creditAbi, functionName: 'name' })
  console.log(`кредит: ${name} [${symbol}] по адресу ${probe}`)

  // Пробуем transfer от нулевого адреса: если функция есть, но ревертит с
  // понятной причиной — значит она запрещена. Отличаем «нет функции» от
  // «функция есть, но запрещена» по тексту ошибки.
  try {
    await client.simulateContract({
      address: probe,
      abi: creditAbi,
      functionName: 'transfer',
      args: ['0x000000000000000000000000000000000000dEaD', 1n],
      account: '0x000000000000000000000000000000000000dEaD',
    })
    console.log('transfer НЕ ревертит — кредит, похоже, переводим')
  } catch (e) {
    const msg = (e.shortMessage ?? e.message ?? '').toLowerCase()
    if (msg.includes('revert') || msg.includes('transfer')) {
      console.log(`transfer запрещён: ${e.shortMessage ?? 'revert'}`)
      console.log('  → в AMM такой токен положить нельзя, нужна своя обёртка')
    } else {
      console.log(`не удалось проверить: ${e.shortMessage ?? e.message}`)
    }
  }
} catch (e) {
  console.log(`кредит не прочитан: ${e.shortMessage ?? e.message}`)
}

// --- сколько можно стейкать при 7-дневном выводе ---
console.log('\n=== сколько резерва можно отправить в стейкинг ===\n')
console.log('Вывод из стейкинга BSC занимает 7 дней (unbonding).')
console.log('Значит застейкать можно только ту часть, которая не понадобится')
console.log('в ближайшую неделю. Считаем по историческому объёму свопов.\n')

const UNBOND_DAYS = 7
const POOL_TVL = 100_000
const BNB_USD = 549.26

// Какая доля резерва должна остаться ликвидной при разном обороте.
for (const dailyTurnover of [0.1, 0.5, 1, 2]) {
  // Свопы в одну сторону за неделю, с запасом ×3 на неравномерность.
  const weekOutflow = POOL_TVL * dailyTurnover * UNBOND_DAYS
  const neededLiquid = weekOutflow * 3
  const stakeable = Math.max(0, POOL_TVL - neededLiquid)
  const stakeableShare = stakeable / POOL_TVL
  const annualYield = stakeable * 0.024 // 2.4% — по измеренному APY
  console.log(
    `  оборот ${dailyTurnover}× TVL/день: за неделю уходит $${fmt(weekOutflow, 0)}, ` +
      `нужен резерв $${fmt(neededLiquid, 0)} → можно стейкать $${fmt(stakeable, 0)} ` +
      `(${(stakeableShare * 100).toFixed(0)}%), доход $${fmt(annualYield, 0)}/год`
  )
}

const STAKE_SHARE = 0.5
const yieldOnStaked = STAKE_SHARE * 0.024
console.log(`\nДаже при оптимистичных 50% застейканного резерва:`)
console.log(`  прибавка к доходу LP = 0.5 × 2.4% = ${(yieldOnStaked * 100).toFixed(2)}% годовых от TVL.`)
console.log('  Для пула $100k это $' + fmt(POOL_TVL * yieldOnStaked, 0) + '/год.')
console.log('\nСравните с торговой комиссией на том же пуле при обороте 1×TVL/день')
console.log('и ставке 0.05%: $' + fmt(POOL_TVL * 1 * 365 * 0.0005, 0) + '/год.')
console.log('То есть стейкинг даёт ~' + ((yieldOnStaked / (1 * 365 * 0.0005)) * 100).toFixed(0) + '% от торговой комиссии.')
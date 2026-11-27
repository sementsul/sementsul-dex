// Проверка всех фактов, изложенных в docs/BOT-MIGRATION.md.

import { createPublicClient, http, keccak256, toHex, parseAbi, formatUnits } from 'viem'
import { bsc } from 'viem/chains'
import artifacts from '../src/contracts/artifacts.json' with { type: 'json' }
import deployments from '../src/contracts/deployments.js'

const client = createPublicClient({ chain: bsc, transport: http('https://bsc-rpc.publicnode.com') })
const POOL = deployments.wbnbUsdtV3Pool
const FACTORY = deployments.v3Factory
const ROUTER = deployments.v3Router

let bad = 0
const check = (name, ok, extra = '') => {
  if (!ok) bad++
  console.log((ok ? '  ok  ' : 'ФЕЙЛ  ') + name + (extra ? '  ' + extra : ''))
}

// --- 2. Пул: порядок токенов, комиссия, шаг тика ---
const t0 = await client.readContract({ address: POOL, abi: artifacts.SementsulV3Pool.abi, functionName: 'token0' })
const t1 = await client.readContract({ address: POOL, abi: artifacts.SementsulV3Pool.abi, functionName: 'token1' })
const fee = await client.readContract({ address: POOL, abi: artifacts.SementsulV3Pool.abi, functionName: 'fee' })
const spacing = await client.readContract({ address: POOL, abi: artifacts.SementsulV3Pool.abi, functionName: 'tickSpacing' })

const USDT = '0x55d398326f99059fF775485246999027B3197955'
const WBNB = deployments.wbnb

check('token0 = USDT', t0.toLowerCase() === USDT.toLowerCase(), t0)
check('token1 = WBNB', t1.toLowerCase() === WBNB.toLowerCase(), t1)
check('fee = 500', Number(fee) === 500, String(fee))
check('tickSpacing = 10', Number(spacing) === 10, String(spacing))

// --- slot0: ровно 5 полей ---
const slot0Abi = artifacts.SementsulV3Pool.abi.find((x) => x.name === 'slot0' && x.type === 'function')
check('slot0 возвращает 5 полей', slot0Abi.outputs.length === 5, `${slot0Abi.outputs.length}`)
check(
  'имена полей совпадают с документом',
  slot0Abi.outputs.map((o) => o.name).join(',') === 'sqrtPriceX96_,tick_,liquidity_,fee_,tickSpacing_',
  slot0Abi.outputs.map((o) => o.name).join(',')
)

// --- Цена: tick -63360 и -62950 ---
// Внимание: меньший тик даёт БОЛЬШУЮ цену USDT за WBNB, потому что цена в
// пуле — это WBNB за USDT (token1 за token0). Проверяем именно это.
const priceAt = (tick) => 1 / Math.pow(1.0001, tick)
check('tick -63360 -> 564.35 USDT за WBNB (нижний тик = верхняя цена)', Math.abs(priceAt(-63360) - 564.35) < 0.02, priceAt(-63360).toFixed(2))
check('tick -62950 -> 541.69 USDT за WBNB (верхний тик = нижняя цена)', Math.abs(priceAt(-62950) - 541.69) < 0.02, priceAt(-62950).toFixed(2))

// --- Задержки вестинга ---
const delays = {}
for (const f of [50, 500, 2500, 10000]) {
  delays[f] = Number(
    await client.readContract({
      address: FACTORY, abi: artifacts.SementsulV3Factory.abi, functionName: 'jitDelayBlocks', args: [f],
    })
  )
}
check('тир 50 -> 250', delays[50] === 250, String(delays[50]))
check('тир 500 -> 1150', delays[500] === 1150, String(delays[500]))
check('тир 2500 -> 5150', delays[2500] === 5150, String(delays[2500]))
check('тир 10000 -> 20150', delays[10000] === 20150, String(delays[10000]))

// --- Селекторы ---
const code = (await client.getBytecode({ address: ROUTER })).toLowerCase()
const sel = (s) => keccak256(toHex(s)).slice(0, 10)
const selChecks = [
  ['exactInputSingle 4 поля = 0xea7ec9c4', 'exactInputSingle((bytes,address,uint256,uint256),uint256)', '0xea7ec9c4'],
  ['exactInputSingle Uniswap = 0x414bf389', 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))', '0x414bf389'],
  ['refundBNB = 0xf37050da', 'refundBNB()', '0xf37050da'],
  ['unwrapWBNB = 0x9d110e71', 'unwrapWBNB(uint256,address)', '0x9d110e71'],
  ['refundETH = 0x12210e8a', 'refundETH()', '0x12210e8a'],
  ['unwrapWETH9 = 0x49404b7c', 'unwrapWETH9(uint256,address)', '0x49404b7c'],
  ['multicall = 0xac9650d8', 'multicall(bytes[])', '0xac9650d8'],
]
for (const [name, sig, expect] of selChecks) {
  const actual = sel(sig)
  check(name, actual === expect, actual)
  // Для наших функций проверяем, что они есть в байткоде роутера.
  if (expect === actual && !['exactInputSingle Uniswap = 0x414bf389', 'refundETH = 0x12210e8a', 'unwrapWETH9 = 0x49404b7c'].includes(name)) {
    check('  и присутствует в коде роутера', code.includes(actual.slice(2)), actual)
  }
}

// --- reversalPenaltyK ---
// Возвращает uint24, viem отдаёт его как number, а не bigint.
// С 2026-11-27 штраф включён: k = 1 000 000, то есть ставка равна сдвигу
// цены. Документ раньше утверждал «0, выключен» — проверяем актуальное.
const k = await client.readContract({
  address: FACTORY, abi: artifacts.SementsulV3Factory.abi, functionName: 'reversalPenaltyK', args: [500],
}).catch(() => null)
check('reversalPenaltyK = 1 000 000 (включён)', Number(k) === 1_000_000, k === null ? 'функция не найдена' : String(k))

// Потолок штрафа: 10%. Ставка не может его превысить.
const cap = await client.readContract({
  address: FACTORY, abi: artifacts.SementsulV3Factory.abi, functionName: 'maxReversalPenalty',
}).catch(() => null)
check('maxReversalPenalty = 100 000 (10%)', Number(cap) === 100_000, cap === null ? 'не найдено' : String(cap))

// --- Ключ позиции: encodePacked против encode ---
//
// Здесь была ловушка, на которой проверка молча врала. Раньше границы
// диапазона брались из события Mint через eth_getLogs. Публичные узлы ведут
// себя непредсказуемо: bsc-dataseed отвечает "Request exceeds defined limit"
// на любой фильтр, publicnode то игнорирует фильтр по topic0 и отдаёт все
// логи пула, то возвращает пустой массив на окне, где события точно есть.
// Скрипт глотал это и печатал «в пуле нет событий Mint» — ложный вывод,
// который выглядел как факт.
//
// Поэтому границы берём не из логов, а из проверенной позиции на цепи:
// диапазон -63500..-63090 открыт получателем на новом пуле. Ниже
// проверяется, что ликвидность там действительно есть. Если пул пересоздадут
// с другим диапазоном, проверка честно провалится, а не соврёт.
const { encodePacked, encodeAbiParameters, parseAbiParameters, keccak256: k256b } = await import('viem')
const owner = '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C'
const KNOWN_LO = -63500
const KNOWN_HI = -63090

const packedKey = k256b(encodePacked(['address', 'int24', 'int24'], [owner, KNOWN_LO, KNOWN_HI]))
const encodedKey = k256b(encodeAbiParameters(parseAbiParameters('address, int24, int24'), [owner, KNOWN_LO, KNOWN_HI]))

const posPacked = await client.readContract({
  address: POOL, abi: artifacts.SementsulV3Pool.abi, functionName: 'positions', args: [packedKey],
})
const posEncoded = await client.readContract({
  address: POOL, abi: artifacts.SementsulV3Pool.abi, functionName: 'positions', args: [encodedKey],
})

check('ключи encodePacked и encode различаются', packedKey !== encodedKey)
check('encodePacked находит позицию с ликвидностью', posPacked[0] > 0n, `L=${posPacked[0]}`)
check('encode на тех же тиках даёт пусто', posEncoded[0] === 0n, `L=${posEncoded[0]}`)

// Раскладка полей positions(): документ утверждает 8 полей и говорит, что
// [0] — liquidity, [3]/[4] — tokensOwed, [5]/[6] — pending, [7] — vestBlock.
// Если это не так, бот прочитает мусор вместо позиции.
check('ответ positions() содержит 8 полей', posPacked.length === 8, `${posPacked.length}`)

// --- Блок ~0.45 с ---
const now = await client.getBlockNumber()
const old = await client.getBlock({ blockNumber: now - 1000n })
const cur = await client.getBlock({ blockNumber: now })
const secPerBlock = Number(cur.timestamp - old.timestamp) / 1000
check('блок ≈ 0.45 с', Math.abs(secPerBlock - 0.45) < 0.15, secPerBlock.toFixed(3))
check('1150 блоков ≈ 8.6 мин', Math.abs((1150 * secPerBlock) / 60 - 8.6) < 2, ((1150 * secPerBlock) / 60).toFixed(1) + ' мин')

console.log('')
console.log(bad === 0 ? 'ВСЕ ФАКТЫ ПОДТВЕРЖДЕНЫ' : `расхождений: ${bad}`)
process.exit(bad === 0 ? 0 : 1)
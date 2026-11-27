// Три несовместимости, которые мешают готовым ботам, и одна опасная.
//
// Проверено на цепи: наш пул отвечает на часть стандартного ABI Uniswap V3,
// но три вызова ломаются. Разберём каждый — важно понять, мешает ли это
// арбитражу (который, как мы видели, УЖЕ идёт) или только ликвидности.
//
//   1. slot0() — 5 полей вместо 7. Числа не те, но тик и цена читаются верно.
//   2. ticks() — 5 полей вместо 8. Декодирование падает.
//   3. observe() — нет оракула вообще. Любой бот, который считает TWAP,
//      получит реверт.
//
// Четвёртое — про колбэк. Проверяем, какой селектор наш пул зовёт у
// вызывающего контракта: uniswapV3SwapCallback (как Uniswap) или свой.
import { createPublicClient, http, parseAbi, keccak256, toHex, toFunctionSelector } from 'viem'
import { bsc } from 'viem/chains'

const POOL = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278'
const client = createPublicClient({
  chain: bsc,
  transport: http('https://bsc-rpc.publicnode.com', { timeout: 30_000 }),
})

// Какие селекторы упоминает наш контракт пула в коде?
// Ищем в исходнике, потому что дизассемблировать байткод долго.
import { readFileSync } from 'node:fs'
const src = readFileSync('contracts/SementsulV3.sol', 'utf8')

console.log('  === КОЛБЭК: что пул зовёт у вызывающего ===')
for (const name of ['uniswapV3SwapCallback', 'pancakeV3SwapCallback', 'sementsulV3SwapCallback']) {
  const present = src.includes(name)
  console.log(`  ${name.padEnd(26)} ${present ? 'ЗОВЁТСЯ' : 'нет'}`)
}

// Проверяем, как формируется calldata колбэка.
const cbMatch = src.match(/(?:abi\.encodeWithSelector|abi\.encodeWithSignature)\([^)]*\)/g)
console.log('')
console.log('  как формируется вызов колбэка (из исходника):')
if (cbMatch) cbMatch.slice(0, 5).forEach((m) => console.log('    ' + m.slice(0, 120)))
else console.log('    не найдено явных encodeWithSelector')

// Ищем сам селектор в тексте — так видно, совпадает ли он с Uniswap.
const UNI_CB = toFunctionSelector('function uniswapV3SwapCallback(int256,int256,bytes)')
console.log('')
console.log('  селектор uniswapV3SwapCallback:', UNI_CB)
console.log('  встречается ли в исходнике:', src.includes(UNI_CB) ? 'ДА' : 'нет (вероятно, вычисляется компилятором)')

// --- Насколько опасна несовместимость для того, кто уже торгует ---
console.log('')
console.log('  === ЧТО ЭТО ЗНАЧИТ ДЛЯ АРБИТРАЖА ===')
console.log('  Арбитраж идёт (39 свопов за 4 часа от MEV-ботов). Значит боты')
console.log('  УЖЕ обходят несовместимость: они не читают slot0 нашим ABI и не')
console.log('  зовут observe — им хватает цены и резервов из событий Swap.')
console.log('')
console.log('  Совместимость нужна не арбитражу, а:')
console.log('    • агрегаторам (1inch, OpenOcean) — они симулируют swap через')
console.log('      quoter и читают slot0 стандартным ABI;')
console.log('    • концентрированным LP-менеджерам (реинвестирование позиций);')
console.log('    • любому коду, который считает TWAP через observe.')

// --- Что реально можно задеплоить ---
console.log('')
console.log('  === ЧТО МОЖНО ЗАДЕПЛОИТЬ ===')
console.log('  1. Адаптер-обёртка «Uniswap-совместимый вид»:')
console.log('     контракт, который отдаёт slot0 из 7 полей (добивая нулями),')
console.log('     ticks из 8 полей, и observe с честным ответом «нет данных».')
console.log('     Плюс: агрегаторы смогут читать пул. Минус: TWAP всё равно не')
console.log('     появится — оракула в пуле физически нет, и адаптер его не создаст.')
console.log('')
console.log('  2. Свой Quoter (как PancakeQuoter): считает ожидаемый выход для')
console.log('     маршрута. Нужен агрегаторам для оценки. Реализуемо без')
console.log('     изменения пула — только читает состояние и считает по формуле.')
console.log('')
console.log('  3. Свой субграф / индексер: чтобы пул попал в чьи-то списки.')
console.log('     Это не контракт, а инфраструктура.')
console.log('')
console.log('  4. Оракул TWAP отдельным контрактом: кто-то (обновлятор) пишет')
console.log('     цену каждый блок или раз в N блоков, читатели берут среднее.')
console.log('     Дорого по газу и требует доверия к обновлятору.')
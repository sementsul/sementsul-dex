// Совместим ли наш роутер с ABI, которым пользуются агрегаторы.
//
// Агрегатор (1inch, OpenOcean, Pancake SmartRouter) не пишет интеграцию под
// каждый DEX — он зовёт стандартный ISwapRouter. Если наш роутер отвечает
// другим набором полей, агрегатор просто не сможет через него торговать.
//
// Это и есть настоящая причина, почему нас нет в маршрутах агрегаторов —
// не «нас не нашли», а «наш интерфейс не тот, который они умеют».
//
// Сравниваем сигнатуры: Uniswap V3 SwapRouter против нашего SementsulV3Router.
import { toFunctionSelector } from 'viem'

const UNISWAP = {
  'exactInputSingle': 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  'exactInput': 'exactInput((bytes,address,uint256,uint256))',
  'exactOutputSingle': 'exactOutputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  'exactOutput': 'exactOutput((bytes,address,uint256,uint256))',
  'uniswapV3SwapCallback': 'uniswapV3SwapCallback(int256,int256,bytes)',
}

const OURS = {
  // Из contracts/SementsulV3Router.sol: ExactInputParams { bytes path;
  // address recipient; uint256 amountIn; uint256 amountOutMinimum; }
  'exactInputSingle': 'exactInputSingle((bytes,address,uint256,uint256),uint256)',
  'exactInput': 'exactInput((bytes,address,uint256,uint256),uint256)',
  'exactOutputSingle': 'exactOutputSingle((bytes,address,uint256,uint256),uint256)',
  'exactOutput': 'exactOutput((bytes,address,uint256,uint256),uint256)',
  'uniswapV3SwapCallback': 'uniswapV3SwapCallback(int256,int256,bytes)',
}

console.log('  функция              Uniswap селектор    наш селектор      совпадает')
let matches = 0
for (const name of Object.keys(UNISWAP)) {
  const u = toFunctionSelector('function ' + UNISWAP[name])
  const o = toFunctionSelector('function ' + OURS[name])
  const same = u === o
  if (same) matches++
  console.log(`  ${name.padEnd(20)} ${u}   ${o}   ${same ? 'ДА' : 'НЕТ'}`)
}

console.log('')
console.log(`  совпало: ${matches} из ${Object.keys(UNISWAP).length}`)
console.log('')
console.log('  === ЧТО ЭТО ЗНАЧИТ ===')
console.log('  У Uniswap exactInputSingle принимает 8 полей в структуре')
console.log('  (tokenIn, tokenOut, fee, recipient, deadline, amountIn,')
console.log('  amountOutMinimum, sqrtPriceLimitX96).')
console.log('')
console.log('  У нас — 4 поля (path, recipient, amountIn, amountOutMinimum)')
console.log('  плюс отдельный аргумент deadline. Это ДРУГОЙ селектор.')
console.log('')
console.log('  Значит агрегатор, написанный под стандартный ISwapRouter,')
console.log('  НЕ СМОЖЕТ вызвать наш роутер. Это не «нас не нашли» —')
console.log('  это несовместимый интерфейс на уровне ABI.')
console.log('')
console.log('  === НО ЕСТЬ ВАЖНАЯ ОГОВОРКА ===')
console.log('  MEV-боты обходят роутер целиком: они зовут pool.swap()')
console.log('  напрямую, а этот селектор у нас ИДЕНТИЧЕН Uniswap')
console.log('  (0x128acb08, проверено вызовом). Поэтому арбитраж идёт,')
console.log('  а агрегаторов нет: разные пути интеграции.')
console.log('')
console.log('  === ВЫВОД ===')
console.log('  Чтобы агрегаторы могли торговать через нас, нужен роутер')
console.log('  с СТАНДАРТНЫМ интерфейсом ISwapRouter. Это деплой нового')
console.log('  роутера — существующий не переделать.')
console.log('  Либо — quoter + прямой pool.swap в маршруте агрегатора.')
console.log('')
console.log('  Второй путь реальнее: агрегатор зовёт пул напрямую, если')
console.log('  умеет строить маршрут в обход своего роутера. Но для этого')
console.log('  наша фабрика должна быть в его конфиге — а это уже не деплой.')
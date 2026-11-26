// Извлекаем тела ключевых функций бота, которые придётся переписать.

import fs from 'node:fs'

const b = fs.readFileSync('_worker-dump/lp-ladder.js', 'utf8')

const want = [
  'addPosition', 'closePosition', 'movePosition', 'listPositions',
  'shapePosition', 'liquidityForBudget', 'ticksForLevel', 'tickFromPrice',
  'priceFromSqrt', 'amountsFor', 'alignTick', 'collectFees',
]

for (const name of want) {
  // Ищем объявление функции: "function name(" или "var name = "
  const idx = b.indexOf(`function ${name}(`)
  const idx2 = b.indexOf(`var ${name} = `)
  const at = idx >= 0 ? idx : idx2
  if (at < 0) {
    console.log(`--- ${name}: не найдена ---\n`)
    continue
  }
  // Берём до маркера __name(name, "name")
  const marker = `__name(${name}, "${name}")`
  const end = b.indexOf(marker, at)
  const body = end > 0 ? b.slice(at, end + marker.length) : b.slice(at, at + 600)
  console.log(`--- ${name} ---`)
  console.log(body.slice(0, 1100))
  console.log('')
}
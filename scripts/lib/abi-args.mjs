// Кодирование аргументов конструктора для скриптов, которые разворачивают
// контракты в локальной EVM без viem/ethers.
//
// Зачем отдельный файл: у фабрики V3 конструктор принимает ДИНАМИЧЕСКИЕ
// массивы (uint24[] и int24[]), а прежний помощник умел только одиночные
// числа и адреса. Дублировать кодирование в трёх скриптах — значит однажды
// поправить в двух из трёх.

const word = (n) => BigInt(n).toString(16).padStart(64, '0')

export function uintWord(n) {
  return word(n)
}

// int24/int256 в дополнительном коде, дополненный до 32 байт.
export function intWord(n) {
  let v = BigInt(n)
  if (v < 0n) v = (1n << 256n) + v
  return v.toString(16).padStart(64, '0')
}

export function addrWord(a) {
  return a.replace(/^0x/, '').toLowerCase().padStart(64, '0')
}

// Значение — либо { type, value }, либо просто число/строка.
function encodeOne(arg) {
  if (typeof arg === 'string') return addrWord(arg)
  if (typeof arg === 'bigint' || typeof arg === 'number') return word(arg)
  throw new Error(`не знаю, как кодировать ${typeof arg}`)
}

// Кодирует список аргументов. Поддерживает динамические массивы вида
// { type: 'uint24[]', value: [500n, 2500n] }.
//
// Раскладка стандартная: сначала «голова» — по слову на аргумент, где у
// динамического массива вместо значения стоит смещение до его данных; потом
// «хвост» — для каждого массива длина и элементы.
export function encodeArgs(args) {
  const heads = []
  const tails = []
  let tailOffset = args.length * 32

  for (const arg of args) {
    if (arg && typeof arg === 'object' && String(arg.type).endsWith('[]')) {
      const items = arg.value.map((v) => encodeOne(v))
      const body = word(items.length) + items.join('')
      heads.push(word(tailOffset))
      tails.push(body)
      tailOffset += body.length / 2
    } else {
      heads.push(encodeOne(arg))
    }
  }

  return heads.join('') + tails.join('')
}
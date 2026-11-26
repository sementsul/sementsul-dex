// Форматирование чисел для UI. Отдельно от логики, чтобы можно было тестировать.

// Округлить BigInt-сумму до человекочитаемой строки с разумным числом знаков.
export function formatAmount(value, decimals, maxSignificant = 6, { group = true } = {}) {
  if (value === null || value === undefined) return '—'
  const big = typeof value === 'bigint' ? value : BigInt(value)
  if (big === 0n) return '0'

  const neg = big < 0n
  const abs = neg ? -big : big
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = abs % base

  let out
  if (whole > 0n) {
    // Показываем столько знаков после запятой, чтобы всего было maxSignificant
    const wholeStr = whole.toString()
    const room = Math.max(0, maxSignificant - wholeStr.length)
    if (room === 0 || frac === 0n) {
      out = wholeStr
    } else {
      const fracStr = frac.toString().padStart(decimals, '0').slice(0, room).replace(/0+$/, '')
      out = fracStr ? `${wholeStr}.${fracStr}` : wholeStr
    }
    // Разряды для длинных целых частей: 107553451 -> 107 553 451
    if (group && wholeStr.length > 4) {
      const [w, f] = out.split('.')
      const grouped = w.replace(/\B(?=(\d{3})+(?!\d))/g, '\u2009')
      out = f ? `${grouped}.${f}` : grouped
    }
  } else {
    // Число меньше единицы: ищем первую значащую цифру
    const fracStr = frac.toString().padStart(decimals, '0')
    const firstSig = fracStr.search(/[1-9]/)
    if (firstSig === -1) return '0'
    const start = firstSig
    const end = Math.min(decimals, start + maxSignificant)
    const slice = fracStr.slice(start, end).replace(/0+$/, '')
    out = `0.${'0'.repeat(start)}${slice}`
  }

  return neg ? `-${out}` : out
}

// Формат денег: 1 234.56
export function formatUsd(n) {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '$0'
  if (n < 0.01) return `<$0.01`
  if (n < 1) return `$${n.toFixed(4)}`
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Значимые цифры для цены: 0.0000000587 -> 5.87e-8
export function formatPrice(n) {
  if (!Number.isFinite(n) || n === 0) return '—'
  if (n >= 1) {
    return n.toLocaleString('en-US', { maximumSignificantDigits: 6 })
  }
  if (n >= 0.0001) return n.toPrecision(4)
  // Научная запись для очень малых
  const exp = Math.floor(Math.log10(n))
  const mant = n / 10 ** exp
  return `${mant.toFixed(2)}e${exp}`
}

// Сократить адрес: 0x1234...abcd
export function shortAddress(addr, chars = 4) {
  if (!addr) return ''
  return `${addr.slice(0, chars + 2)}...${addr.slice(-chars)}`
}

// Разобрать пользовательский ввод в BigInt с нужными decimals.
export function parseAmount(input, decimals) {
  if (!input) return 0n
  // Убираем разрядочные пробелы (в т.ч. тонкий U+2009), которые ставит formatAmount,
  // иначе «МАКС» подставит число, которое не распарсится обратно.
  const s = String(input)
    .replace(/[\s\u2009\u00a0]/g, '')
    .replace(/,/g, '.')
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return 0n
  const [whole, frac = ''] = s.split('.')
  const fracPadded = frac.padEnd(decimals, '0').slice(0, decimals)
  return BigInt((whole || '0') + fracPadded)
}

// Процент из bps: 25 -> "0.25%"
export function formatBps(bps) {
  if (!Number.isFinite(bps)) return '—'
  if (bps < 1) return '<0.01%'
  return `${(bps / 100).toFixed(bps < 100 ? 2 : 1)}%`
}

// Длительность в секундах -> "2 мин"
export function formatDuration(sec) {
  if (sec < 60) return `${sec} сек`
  if (sec < 3600) return `${Math.round(sec / 60)} мин`
  return `${Math.round(sec / 3600)} ч`
}
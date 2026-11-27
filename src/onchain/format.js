// Вспомогательное: форматирование чисел без зависимостей.

export function fmtAmount(raw, decimals, maxFrac = 6) {
  if (raw === null || raw === undefined) return '—'
  const v = typeof raw === 'bigint' ? raw : BigInt(raw)
  if (v === 0n) return '0'
  const neg = v < 0n
  const abs = neg ? -v : v
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = abs % base

  let fracStr = frac.toString().padStart(decimals, '0').slice(0, maxFrac)
  fracStr = fracStr.replace(/0+$/, '')

  const wholeStr = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  const s = fracStr ? wholeStr + '.' + fracStr : wholeStr
  return (neg ? '-' : '') + s
}

// Компактно: 1.23M, 45.6K
export function fmtShort(raw, decimals) {
  const n = Number(raw) / 10 ** decimals
  if (!isFinite(n)) return '—'
  if (n === 0) return '0'
  if (n < 0.0001) return '<0.0001'
  if (n < 1) return n.toFixed(4)
  if (n < 1000) return n.toFixed(2)
  if (n < 1e6) return (n / 1e3).toFixed(2) + 'K'
  if (n < 1e9) return (n / 1e6).toFixed(2) + 'M'
  return (n / 1e9).toFixed(2) + 'B'
}

export function fmtUsd(n) {
  if (!isFinite(n)) return '—'
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  if (n < 1000) return '$' + n.toFixed(2)
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

export function shortAddr(a) {
  if (!a) return ''
  return a.slice(0, 6) + '…' + a.slice(-4)
}

export function shortHash(h) {
  if (!h) return ''
  return h.slice(0, 10) + '…' + h.slice(-6)
}

// Парсит ввод пользователя в минимальные единицы. Возвращает 0n при мусоре.
export function parseAmount(str, decimals) {
  const s = String(str ?? '').trim().replace(',', '.')
  if (!s || !/^\d*\.?\d*$/.test(s)) return 0n
  const [w, f = ''] = s.split('.')
  const frac = f.slice(0, decimals).padEnd(decimals, '0')
  const whole = w || '0'
  try {
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || '0')
  } catch {
    return 0n
  }
}

export function applySlippage(amount, bps) {
  return (amount * BigInt(10000 - bps)) / 10000n
}

export function deadlineFromNow(sec = 1200) {
  return BigInt(Math.floor(Date.now() / 1000) + sec)
}

export function timeAgo(ts) {
  const d = Math.floor(Date.now() / 1000) - ts
  if (d < 60) return d + ' с'
  if (d < 3600) return Math.floor(d / 60) + ' мин'
  if (d < 86400) return Math.floor(d / 3600) + ' ч'
  return Math.floor(d / 86400) + ' д'
}
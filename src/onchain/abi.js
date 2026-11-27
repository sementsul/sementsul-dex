// ABI без зависимостей: только то, что нужно DEX. Селекторы захардкожены,
// поэтому keccak в сборку не попадает (экономит ~15 KB).
export const SEL = {
  // ERC-20
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
  approve: '0x095ea7b3',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  name: '0x06fdde03',
  // V2
  getPair: '0xe6a43905',
  createPair: '0xc9c65396',
  getReserves: '0x0902f1ac',
  token0: '0x0dfe1681',
  token1: '0xd21220a7',
  allPairsLength: '0x574f2ba3',
  allPairs: '0x1e3dd18b',
  totalSupply: '0x18160ddd',
  // V3
  getPool: '0x1698ee82',
  slot0: '0x3850c7bd',
  liquidity: '0x1a686502',
  fee: '0xddca3f43',
  tickSpacing: '0xd0c93a7c',
  feeTiersLength: '0x11b32601',
  feeTiers: '0x230ed44a',
  tickSpacingFor: '0x35fb8cf4',
  createPool: '0xa1671295',
  poolFor: '0x6b6f4f8f',
  quoteExactInputSingle: '0xc6a5026a',
  positions: '0x514ea4bf',
  // пул V3: действия
  mint: '0xb8cca34e',
  burn: '0xa34123a7',
  collect: '0x4f1eb3d8',
  // роутеры
  exactInputSingleOwn: '0xea7ec9c4',
  exactInputSinglePancake: '0x414bf389',
  multicall: '0xac9650d8',
  unwrapWBNB: '0x9d110e71',
  wrapBNB: '0xe29c2126',
  refundBNB: '0xf37050da',
  // V2 роутер
  addLiquidity: '0xe8e33700',
  addLiquidityETH: '0xf305d719',
  removeLiquidity: '0xbaa2abde',
  removeLiquidityETH: '0x02751cec',
  removeLiquidityETHSupportingFeeOnTransferTokens: '0xaf2979eb',
  swapExactETHForTokens: '0x7ff36ab5',
  swapExactTokensForETH: '0x18cbafe5',
  swapExactTokensForTokens: '0x38ed1739',
  // WBNB
  deposit: '0xd0e30db0',
  withdraw: '0x2e1a7d4d',
}

const ZERO = '0x0000000000000000000000000000000000000000'
export { ZERO }

const MASK = (1n << 64n) - 1n

export function encUint(v) {
  const n = BigInt(v)
  const twos = n < 0n ? (1n << 256n) + n : n
  return twos.toString(16).padStart(64, '0')
}

export const encInt = encUint

export function encAddr(a) {
  return a.replace(/^0x/i, '').toLowerCase().padStart(64, '0')
}

export function encBool(b) {
  return (b ? '1' : '0').padStart(64, '0')
}

// bytes: длина + данные, добитые до кратности 32
export function encBytes(hex) {
  const h = hex.replace(/^0x/i, '')
  const len = h.length / 2
  let padded = h
  while (padded.length % 64 !== 0) padded += '0'
  return encUint(len) + padded
}

export function encodeCall(sel, ...parts) {
  return sel + parts.join('')
}

// ---------- декодирование ----------
export function words(hex) {
  const h = (hex ?? '0x').replace(/^0x/i, '')
  const out = []
  for (let i = 0; i + 64 <= h.length; i += 64) out.push(h.slice(i, i + 64))
  return out
}

export function decUint(hex, i = 0) {
  const w = words(hex)
  if (!w[i]) return 0n
  return BigInt('0x' + w[i])
}

export function decAddress(hex, i = 0) {
  const w = words(hex)
  if (!w[i]) return ZERO
  return '0x' + w[i].slice(24)
}

export function decInt(hex, i = 0) {
  let v = decUint(hex, i)
  if (v >= 1n << 255n) v -= 1n << 256n
  return v
}

export function decUints(hex, n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(decUint(hex, i))
  return out
}

export function decString(hex) {
  const w = words(hex)
  if (w.length < 2) return ''
  const len = Number(BigInt('0x' + w[1])) // offset=0x20, len во втором слове
  if (!len) return ''
  const s = (hex ?? '').replace(/^0x/i, '')
  const raw = s.slice(128, 128 + len * 2)
  const bytes = new Uint8Array((raw.match(/.{1,2}/g) ?? []).map((b) => parseInt(b, 16)))
  return new TextDecoder().decode(bytes)
}

// ---------- keccak256 ----------
// Keccak-256 (оригинальный, не NIST SHA3-256: другое дополнение — 0x01, а не 0x06).
// Нужен для ключа позиции: keccak256(abi.encodePacked(owner, int24, int24)).
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]

// Смещения rho, индекс = x + 5*y
const ROT = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
]

function rotl(x, n) {
  if (n === 0) return x & MASK
  const b = BigInt(n)
  return ((x << b) | (x >> (64n - b))) & MASK
}

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    // theta
    const C = []
    for (let i = 0; i < 5; i++) C[i] = s[i] ^ s[i + 5] ^ s[i + 10] ^ s[i + 15] ^ s[i + 20]
    const D = []
    for (let i = 0; i < 5; i++) D[i] = C[(i + 4) % 5] ^ rotl(C[(i + 1) % 5], 1)
    for (let i = 0; i < 25; i++) s[i] ^= D[i % 5]

    // rho + pi: B[y + 5*((2x+3y) mod 5)] = rotl(A[x + 5y], ROT[x + 5y])
    const B = new Array(25)
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        const idx = x + 5 * y
        const nx = y
        const ny = (2 * x + 3 * y) % 5
        B[nx + 5 * ny] = rotl(s[idx], ROT[idx])
      }
    }

    // chi
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        s[x + 5 * y] = B[x + 5 * y] ^ (~B[((x + 1) % 5) + 5 * y] & MASK & B[((x + 2) % 5) + 5 * y])
      }
    }

    // iota
    s[0] ^= RC[round]
  }
}

export function keccak256(hexInput) {
  const bytes = hexInput.replace(/^0x/i, '')
  const rate = 136 // 1088 бит
  const msg = []
  for (let i = 0; i < bytes.length; i += 2) msg.push(parseInt(bytes.slice(i, i + 2), 16))

  msg.push(0x01)
  while (msg.length % rate !== rate - 1) msg.push(0)
  msg.push(0x80)

  const s = new Array(25).fill(0n)
  for (let off = 0; off < msg.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let v = 0n
      for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(msg[off + i * 8 + b] ?? 0)
      s[i] ^= v
    }
    keccakF(s)
  }

  let out = ''
  for (let i = 0; i < 4; i++) {
    let v = s[i]
    for (let b = 0; b < 8; b++) {
      out += Number(v & 0xffn).toString(16).padStart(2, '0')
      v >>= 8n
    }
  }
  return out
}

// Ключ позиции в нашем пуле: keccak256(abi.encodePacked(owner, int24, int24))
export function positionKey(owner, tickLower, tickUpper) {
  const o = owner.replace(/^0x/i, '').toLowerCase().padStart(40, '0')
  const lo = encUint(tickLower).slice(-6)
  const hi = encUint(tickUpper).slice(-6)
  return '0x' + keccak256(o + lo + hi)
}
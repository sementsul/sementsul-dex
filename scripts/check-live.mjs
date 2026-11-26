// Проверка живого сайта: подвал и наличие статей.

const base = 'https://sementsul.net'
const res = await fetch(base, { headers: { 'cache-control': 'no-cache' } })
const html = await res.text()
const m = html.match(/assets\/index-[A-Za-z0-9_-]+\.js/)
console.log('HTTP', res.status, '| бандл:', m ? m[0] : '?')

const b = await (await fetch(`${base}/${m[0]}`)).text()

const anchorPancake = 'href:"https://pancakeswap.finance"'
const anchorBsc = 'href:"https://bscscan.com"'

const checks = [
  ['ссылки на PancakeSwap в подвале нет', !b.includes(anchorPancake)],
  ['ссылка на BscScan осталась', b.includes(anchorBsc)],
  ['статья про MEV на месте', b.includes('MEV: как чужие боты')],
  ['статья про JIT на месте', b.includes('JIT-ликвидность')],
  ['статья про контракты на месте', b.includes('Контракты биржи')],
  ['копирование адреса на месте', b.includes('скопировать адрес')],
]

let bad = 0
for (const [name, ok] of checks) {
  if (!ok) bad++
  console.log((ok ? '  ok  ' : 'ФЕЙЛ  ') + name)
}
console.log('')
console.log(bad === 0 ? 'всё верно' : `проблем: ${bad}`)
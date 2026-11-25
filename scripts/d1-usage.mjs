// Расход D1: сколько строк читается и пишется по каждой базе.
//
// Нужен, чтобы понять, что именно исчерпало бесплатный лимит: наш индексатор,
// чужие боты на других базах, или всё вместе.
//
// Бесплатный тариф D1 даёт 5 млн прочитанных строк в сутки на АККАУНТ
// (не на базу), поэтому важен общий расход, а не по одной базе.

import { readFileSync } from 'node:fs'

const TOKEN = process.argv[2]
const ACCOUNT = process.argv[3]

if (!TOKEN || !ACCOUNT) {
  console.error('использование: node scripts/d1-usage.mjs <token> <account_id>')
  process.exit(1)
}

async function gql(query, variables) {
  const r = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  const j = await r.json()
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 500))
  return j.data
}

// Имена баз: по id непонятно, чья это база.
async function databases() {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database?per_page=100`,
    { headers: { authorization: 'Bearer ' + TOKEN } }
  )
  const j = await r.json()
  const map = new Map()
  for (const d of j.result ?? []) map.set(d.uuid, d.name)
  return map
}

const QUERY = `
query ($acc: String!, $from: Date, $to: Date) {
  viewer {
    accounts(filter: { accountTag: $acc }) {
      d1AnalyticsAdaptiveGroups(
        limit: 1000
        filter: { date_geq: $from, date_leq: $to }
        orderBy: [date_ASC]
      ) {
        sum {
          rowsRead
          rowsWritten
        }
        dimensions {
          date
          databaseId
        }
      }
    }
  }
}
`

const today = new Date()
const from = new Date(today.getTime() - 6 * 86400_000).toISOString().slice(0, 10)
const to = today.toISOString().slice(0, 10)

const names = await databases()
const data = await gql(QUERY, { acc: ACCOUNT, from, to })
const rows = data.viewer.accounts[0]?.d1AnalyticsAdaptiveGroups ?? []

if (rows.length === 0) {
  console.log('данных нет: либо расход нулевой, либо аналитика ещё не собралась')
  process.exit(0)
}

// Сводим по базе и по дню.
const byDb = new Map()
for (const x of rows) {
  const id = x.dimensions.databaseId
  const cur = byDb.get(id) ?? { read: 0, written: 0, days: [] }
  cur.read += Number(x.sum.rowsRead)
  cur.written += Number(x.sum.rowsWritten)
  cur.days.push({ date: x.dimensions.date, read: Number(x.sum.rowsRead) })
  byDb.set(id, cur)
}

console.log(`=== расход D1 за ${from} .. ${to} ===\n`)
console.log('база                              прочитано      записано   доля')
console.log('-'.repeat(72))

const totalRead = [...byDb.values()].reduce((s, v) => s + v.read, 0)
const sorted = [...byDb.entries()].sort((a, b) => b[1].read - a[1].read)
for (const [id, v] of sorted) {
  const name = names.get(id) ?? id.slice(0, 8)
  const share = totalRead ? ((v.read / totalRead) * 100).toFixed(1) + '%' : '-'
  console.log(
    name.padEnd(32),
    String(v.read).padStart(12),
    String(v.written).padStart(12),
    share.padStart(7)
  )
}
console.log('-'.repeat(72))
console.log('ИТОГО'.padEnd(32), String(totalRead).padStart(12))

// Лимит бесплатного тарифа: 5 млн строк в сутки.
const LIMIT = 5_000_000
const byDay = new Map()
for (const x of rows) {
  const d = x.dimensions.date
  byDay.set(d, (byDay.get(d) ?? 0) + Number(x.sum.rowsRead))
}

console.log('\n=== по дням (лимит ' + LIMIT.toLocaleString('ru') + ' строк в сутки) ===\n')
for (const [d, v] of [...byDay.entries()].sort()) {
  const pct = ((v / LIMIT) * 100).toFixed(1)
  const bar = '#'.repeat(Math.min(40, Math.round((v / LIMIT) * 40)))
  console.log(`  ${d}  ${String(v).padStart(10)}  ${pct.padStart(6)}%  ${bar}`)
}

const todayRead = byDay.get(to) ?? 0
console.log('')
if (todayRead >= LIMIT) {
  console.log(`сегодня лимит ИСЧЕРПАН: ${todayRead.toLocaleString('ru')} из ${LIMIT.toLocaleString('ru')}`)
} else {
  console.log(`сегодня прочитано ${todayRead.toLocaleString('ru')} из ${LIMIT.toLocaleString('ru')}`)
}

// Главный вывод: чья база съедает больше всех.
const top = sorted[0]
if (top) {
  const name = names.get(top[0]) ?? top[0].slice(0, 8)
  const share = totalRead ? ((top[1].read / totalRead) * 100).toFixed(0) : '0'
  console.log(`\nбольше всех читает база «${name}» — ${share}% всего расхода`)
}
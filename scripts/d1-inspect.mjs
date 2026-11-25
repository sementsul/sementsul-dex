// Что читает база lp-ladder: схема и объём.
//
// Нужен, чтобы понять, откуда 13 млн прочитанных строк в неделю. Гипотезы:
// таблица растёт без очистки, запрос без индекса (полный скан), либо запрос
// в цикле по каждой позиции.
//
// Использование: node scripts/d1-inspect.mjs <token> <account_id> <database_id>

const TOKEN = process.argv[2]
const ACCOUNT = process.argv[3]
const DB = process.argv[4]

async function sql(query) {
  const r = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`,
    {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ sql: query }),
    }
  )
  const j = await r.json()
  if (!j.success) throw new Error(JSON.stringify(j.errors).slice(0, 300))
  return j.result?.[0]?.results ?? []
}

console.log('=== схема ===\n')
const objects = await sql(
  "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','index') ORDER BY type, name"
)
for (const o of objects) {
  console.log(`${o.type}: ${o.name}`)
}

console.log('\n=== размер таблиц (по числу строк) ===\n')
for (const o of objects.filter((x) => x.type === 'table')) {
  try {
    const c = await sql(`SELECT COUNT(*) AS n FROM "${o.name}"`)
    console.log('  ' + o.name.padEnd(28), c[0].n)
  } catch (e) {
    console.log('  ' + o.name.padEnd(28), 'ошибка: ' + e.message.slice(0, 60))
  }
}
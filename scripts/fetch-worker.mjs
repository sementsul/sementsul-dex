// Скачать исходник воркера с Cloudflare, чтобы прочитать логику диапазонов.
//
// В рабочей папке кода бота нет: он задеплоен только на Cloudflare. Читать
// его издалека нельзя, поэтому выгружаем скрипт и смотрим локально.
//
// Использование: node scripts/fetch-worker.mjs <token> <account_id> <worker_name>

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN = process.argv[2]
const ACCOUNT = process.argv[3]
const NAME = process.argv[4]

if (!TOKEN || !ACCOUNT || !NAME) {
  console.error('использование: node scripts/fetch-worker.mjs <token> <account_id> <worker_name>')
  process.exit(1)
}

// Cloudflare отдаёт содержимое скрипта по этому адресу; Accept: */* важен,
// иначе приходит только метаданные.
const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${NAME}`
const res = await fetch(url, {
  headers: { authorization: 'Bearer ' + TOKEN },
})

if (!res.ok) {
  console.error('ошибка:', res.status, (await res.text()).slice(0, 300))
  process.exit(1)
}

const text = await res.text()

const dir = join(process.cwd(), '_worker-dump')
mkdirSync(dir, { recursive: true })
const out = join(dir, NAME + '.js')
writeFileSync(out, text, 'utf8')

console.log(`сохранено: ${out}`)
console.log(`размер: ${text.length} байт`)
console.log(`строк: ${text.split('\n').length}`)
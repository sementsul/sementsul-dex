// Почему check-admin не увидел DEPLOYER_KEY и чей это адрес.
//
// Разбор построчный: печатаем имя каждой переменной и длину значения. Это
// покажет, ловится ли строка регуляркой и нет ли лишних символов.
import { readFileSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'

const raw = readFileSync('.env', 'utf8')
console.log('  размер файла:', raw.length, 'байт')
console.log('  первые байты:', JSON.stringify(raw.slice(0, 3)))
console.log('  перевод строки:', raw.includes('\r\n') ? 'CRLF' : 'LF')
console.log('')

const lines = raw.split('\n')
for (const line of lines) {
  const t = line.replace(/\r$/, '')
  if (!t.trim() || t.trim().startsWith('#')) continue
  const m = t.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/)
  if (!m) {
    console.log(`  [не распознано] ${JSON.stringify(t.slice(0, 60))}`)
    continue
  }
  const name = m[1]
  const val = m[2].trim().replace(/^["']|["']$/g, '')
  let who = ''
  if (/KEY$/.test(name) && /^0x[0-9a-fA-F]{64}$/.test(val)) {
    try {
      who = ' → ' + privateKeyToAccount(val).address
    } catch (e) {
      who = ' → ключ битый: ' + String(e.message).slice(0, 40)
    }
  } else if (/KEY$/.test(name)) {
    who = ` → не похоже на 32-байтный ключ (длина ${val.length})`
  }
  console.log(`  ${name.padEnd(20)} длина ${String(val.length).padEnd(4)}${who}`)
}
// Создание кошелька деплоера.
//
// Что делает:
//   1. генерирует новую пару ключей (или берёт существующую из .env);
//   2. записывает приватный ключ в .env — файл в .gitignore, в репозиторий
//      не попадёт;
//   3. печатает ТОЛЬКО адрес: приватный ключ в консоль не выводится никогда,
//      иначе он останется в логах терминала и в истории буфера.
//
// Повторный запуск ничего не перезаписывает: если ключ уже есть, скрипт
// просто покажет адрес. Это защита от случайной потери денег, отправленных
// на первый адрес.

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ENV_PATH = join(ROOT, '.env')

function readEnv() {
  if (!existsSync(ENV_PATH)) return {}
  const out = {}
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return out
}

const env = readEnv()
let privateKey = env.DEPLOYER_KEY

if (privateKey) {
  console.log('ключ уже есть в .env — новый не создаю')
  console.log('(перезапись потеряла бы деньги, отправленные на текущий адрес)')
} else {
  privateKey = generatePrivateKey()
  if (!privateKey.startsWith('0x')) privateKey = '0x' + privateKey

  const block =
    '\n# Приватный ключ деплоера. Файл в .gitignore — в репозиторий не попадает.\n' +
    '# Никому не показывать: кто знает ключ, тот распоряжается балансом.\n' +
    `DEPLOYER_KEY=${privateKey}\n`

  const prev = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
  writeFileSync(ENV_PATH, prev + block, 'utf8')
  console.log('ключ записан в .env')
}

const account = privateKeyToAccount(privateKey)

console.log('')
console.log('АДРЕС ДЛЯ ПОПОЛНЕНИЯ:')
console.log('')
console.log('    ' + account.address)
console.log('')
console.log('Сеть: BNB Smart Chain (BSC), chainId 56.')
console.log('Отправляйте BNB только в этой сети — в других сетях деньги потеряются.')
console.log('')
console.log('Сколько нужно: примерно 0.01 BNB.')
console.log('Деплой четырёх контрактов (фабрика V2, фабрика V3, два роутера)')
console.log('по текущим ценам газа укладывается в 0.005-0.01 BNB.')
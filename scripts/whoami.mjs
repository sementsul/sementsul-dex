// Кто мы такие: адрес, выведенный из ключей в .env.
//
// Это первое, что надо проверить перед любой транзакцией за позицию. Ключ
// может быть от другого адреса, и тогда подпись просто не пройдёт — но хуже,
// если пройдёт за чужой счёт.
import { readFileSync } from 'node:fs'
import { privateKeyToAccount } from 'viem/accounts'

const env = {}
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
}

const NAMES = ['DEPLOYER_KEY', 'RECEIVER_KEY', 'MIRROR_KEY']
const KNOWN = {
  '0x22eA591615435a2aF0F705962f85C55FE7B4eB5C': 'получатель (владелец нашей позиции)',
  '0xC6CF1A60a724c794BeE2F5425D1e418E8c2deb3A': 'зеркало (деплой в цепь)',
  '0x922598c9D529836b4b475cE74188D5EeFFb83a88': 'бот',
}

for (const name of NAMES) {
  const raw = env[name]
  if (!raw) {
    console.log(`  ${name.padEnd(14)}: НЕТ`)
    continue
  }
  const hex = raw.startsWith('0x') ? raw : '0x' + raw
  try {
    const acc = privateKeyToAccount(hex)
    const label = KNOWN[acc.address] ?? 'неизвестный адрес'
    console.log(`  ${name.padEnd(14)}: ${acc.address}  — ${label}`)
  } catch (e) {
    console.log(`  ${name.padEnd(14)}: ключ не читается (${String(e.message).slice(0, 60)})`)
  }
}
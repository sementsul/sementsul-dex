// Кошелёк для деплоя зеркала в BSC.
// Создаёт новый ключ (если ещё нет), дописывает в .env как MIRROR_KEY.
// Приватный ключ НЕ печатается — только адрес.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const ENV = '.env'

let env = ''
if (existsSync(ENV)) env = readFileSync(ENV, 'utf8')

const has = /^MIRROR_KEY=/m.test(env)

let key
if (has) {
  const m = env.match(/^MIRROR_KEY=(.*)$/m)
  key = m[1].trim().replace(/^["']|["']$/g, '')
  console.log('ключ уже есть в .env, использую его')
} else {
  key = generatePrivateKey()
  const add = (env.endsWith('\n') || env === '' ? '' : '\n') + `MIRROR_KEY=${key}\n`
  writeFileSync(ENV, env + add, 'utf8')
  console.log('создан новый ключ, дописан в .env как MIRROR_KEY')
}

const account = privateKeyToAccount(key)

const rpc = async (method, params) => {
  const r = await fetch('https://bsc-rpc.publicnode.com', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  })
  return r.json()
}

;(async () => {
  const bal = BigInt((await rpc('eth_getBalance', [account.address, 'latest'])).result)
  const nonce = parseInt((await rpc('eth_getTransactionCount', [account.address, 'latest'])).result, 16)

  console.log('\n=== кошелёк для деплоя ===')
  console.log('  адрес :', account.address)
  console.log('  BNB   :', Number(bal) / 1e18)
  console.log('  nonce :', nonce)
  console.log('\n  пополните этот адрес в сети BNB Chain (BEP-20 BNB)')
})().catch((e) => console.error('ошибка:', e.message))
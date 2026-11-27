#!/usr/bin/env node
// Загрузка собранного зеркала на Pinata.
//
// Отправляет каталог dist-mirror как один IPFS-каталог: все файлы уходят в
// одном запросе с общим корнем, поэтому ссылки './assets/…' внутри страницы
// продолжают работать на шлюзе.
//
//   PINATA_JWT=… node scripts/pin-mirror.mjs [--name=…]
//
// Ключ передаётся переменной окружения, а не аргументом: аргументы видны в
// списке процессов и попадают в историю команд.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const ROOT = 'dist-mirror'
const JWT = process.env.PINATA_JWT

if (!JWT) {
  console.error('нужен PINATA_JWT в окружении')
  process.exit(1)
}

const nameArg = process.argv.find((a) => a.startsWith('--name='))
const NAME = nameArg ? nameArg.slice('--name='.length) : `sementsul-mirror-${Date.now()}`

async function walk(dir) {
  const out = []
  for (const entry of await readdir(dir)) {
    const p = join(dir, entry)
    const s = await stat(p)
    if (s.isDirectory()) out.push(...(await walk(p)))
    else out.push(p)
  }
  return out
}

const files = await walk(ROOT)
console.log(`\nфайлов: ${files.length}`)

const form = new FormData()
for (const f of files) {
  // Путь внутри архива — относительно корня сборки, с прямыми слэшами.
  //
  // Pinata принимает либо один файл, либо один каталог, но не плоский список
  // файлов: на плоском списке отвечает 400 «More than one file and/or
  // directory was provided for pinning». Поэтому каждый путь получает общий
  // префикс — так все файлы оказываются внутри одного каталога, и у пина
  // появляется единый корневой CID.
  //
  // Префикс не влияет на работу сайта: ссылки в index.html относительные, и
  // каталог становится корнем раздачи на шлюзе.
  const inner = relative(ROOT, f).split(sep).join('/')
  const rel = `mirror/${inner}`
  const body = await readFile(f)
  form.append('file', new Blob([body]), rel)
}

form.append('pinataMetadata', JSON.stringify({ name: NAME }))
// cidVersion 1: base32-адрес, который понимают шлюзы и DNSLink.
form.append('pinataOptions', JSON.stringify({ cidVersion: 1 }))

console.log(`загружаю как «${NAME}»…\n`)

const res = await fetch('https://api.pinata.cloud/pinning/pinFileToIPFS', {
  method: 'POST',
  headers: { Authorization: `Bearer ${JWT}` },
  body: form,
})

const text = await res.text()
if (!res.ok) {
  console.error(`ошибка ${res.status}: ${text}`)
  process.exit(1)
}

const data = JSON.parse(text)
console.log(`CID: ${data.IpfsHash}`)
console.log(`размер: ${(data.PinSize / 1024).toFixed(1)} KB`)
console.log(`\nшлюз: https://gateway.pinata.cloud/ipfs/${data.IpfsHash}/`)
console.log(`\nдля поддомена нужно указать этот CID, а не DNSLink.\n`)
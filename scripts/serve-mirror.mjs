// Локальная проверка зеркала: отдаёт dist-mirror по подпути /ipfs/<CID>/.
//
// Это повторяет поведение шлюза: на IPFS контент живёт не в корне домена, а по
// адресу вида /ipfs/<CID>/…, поэтому абсолютные пути '/assets/…' там ломаются.
// Сервер воспроизводит ровно этот случай, чтобы поймать проблему до загрузки.
//
//   node scripts/serve-mirror.mjs [port]
//
// Служебный скрипт, в набор тестов не входит.

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, normalize } from 'node:path'

const PORT = Number(process.argv[2] ?? 8801)
const CID = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi'
const PREFIX = `/ipfs/${CID}/`
const ROOT = 'dist-mirror'

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  let path = decodeURIComponent(url.pathname)

  if (path === '/' || path === '') {
    res.writeHead(302, { location: PREFIX })
    res.end()
    return
  }

  if (!path.startsWith(PREFIX)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`вне зеркала: только ${PREFIX}*`)
    return
  }

  let rel = path.slice(PREFIX.length)
  if (rel === '' || rel.endsWith('/')) rel += 'index.html'

  // Защита от выхода за пределы каталога.
  const target = normalize(join(ROOT, rel))
  if (!target.startsWith(normalize(ROOT))) {
    res.writeHead(403).end()
    return
  }

  try {
    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      // Кеш как на шлюзе: контент по CID неизменяем.
      'cache-control': 'public, max-age=31536000, immutable',
    })
    res.end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('not found')
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`\nЗеркало: http://127.0.0.1:${PORT}/`)
  console.log(`По подпути: http://127.0.0.1:${PORT}${PREFIX}\n`)
})
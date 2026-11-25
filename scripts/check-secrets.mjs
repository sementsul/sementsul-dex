// Проверка перед публикацией: не утекают ли секреты в репозиторий.
//
// Запускается один раз руками, но лучше — всегда: цена ошибки несимметрична.
// Опознали утечку до git push — просто исправили файл. После push ключ уже в
// истории и в форках, и его надо считать скомпрометированным.
//
// Что ищем:
//   1. приватный ключ (64 hex-символа) рядом со словами key/private/secret;
//   2. ключ API Etherscan в коде (а не в .env);
//   3. токены GitHub и Cloudflare;
//   4. сам .env, если он вдруг не в .gitignore.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.argv[2] ?? process.cwd()

const SKIP_DIRS = new Set([
  'node_modules',
  'foundry-out',
  'out',
  'dist',
  'lib',
  'cache',
  '.git',
  '.wrangler',
  '.npm-cache',
])

const TEXT_EXT = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.sol',
  '.json',
  '.toml',
  '.yml',
  '.yaml',
  '.md',
  '.html',
  '.css',
  '.sql',
  '.sh',
])

const PATTERNS = [
  {
    name: 'приватный ключ',
    re: /(?:private[_-]?key|deployer[_-]?key|secret[_-]?key|PRIVATE_KEY|DEPLOYER_KEY)\s*[:=]\s*['"]?(?:0x)?[0-9a-fA-F]{64}/i,
    why: 'ключ от денег',
  },
  {
    name: 'ключ Etherscan в коде',
    re: /\b[A-Z0-9]{34}\b(?=[^\n]{0,80}(etherscan|bscscan))/i,
    why: 'ключ API',
  },
  {
    name: 'токен GitHub',
    re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/,
    why: 'доступ к репозиториям',
  },
  {
    name: 'токен Cloudflare',
    re: /\b[A-Za-z0-9_-]{40}\b(?=[^\n]{0,60}cloudflare)/i,
    why: 'доступ к деплою',
  },
  {
    name: 'ключ вида 64 hex без контекста',
    re: /^\s*(?:0x)?[0-9a-fA-F]{64}\s*$/m,
    why: 'похоже на приватный ключ',
  },
]

const findings = []

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue
      walk(full)
      continue
    }
    const ext = entry.slice(entry.lastIndexOf('.'))
    if (!TEXT_EXT.has(ext)) continue
    // Артефакты компиляции — это байткод, там 64 hex-символа норма.
    if (entry === 'artifacts.json') continue

    let text
    try {
      text = readFileSync(full, 'utf8')
    } catch {
      continue
    }

    for (const p of PATTERNS) {
      const m = text.match(p.re)
      if (!m) continue
      const idx = text.indexOf(m[0])
      const line = text.slice(0, idx).split('\n').length
      findings.push({
        file: relative(ROOT, full),
        line,
        pattern: p.name,
        why: p.why,
        sample: m[0].slice(0, 20) + '…',
      })
    }
  }
}

console.log('=== проверка на утечку секретов ===\n')
walk(ROOT)

// Отдельно: .env обязан быть в .gitignore.
const gitignorePath = join(ROOT, '.gitignore')
let envIgnored = false
if (existsSync(gitignorePath)) {
  const gi = readFileSync(gitignorePath, 'utf8')
  envIgnored = /^\s*\.env\s*$/m.test(gi)
}
if (!envIgnored) {
  findings.push({
    file: '.gitignore',
    line: 0,
    pattern: '.env не игнорируется',
    why: 'ключи уйдут в репозиторий',
    sample: '',
  })
}

if (findings.length === 0) {
  console.log('чисто: ни приватных ключей, ни токенов в коде нет')
  console.log('.env закрыт .gitignore')
  process.exit(0)
}

for (const f of findings) {
  console.log(`  ${f.file}:${f.line}  ${f.pattern}  (${f.why})  ${f.sample}`)
}
console.log(`\nНАЙДЕНО: ${findings.length}. Публиковать нельзя, пока не исправлено.`)
process.exit(1)
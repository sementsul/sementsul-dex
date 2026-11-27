// Сборка on-chain версии: один самодостаточный HTML.
//
// Зачем свой мини-бандлер. Vite тянет React и viem — это 240 KB минимум,
// а каждый байт в блокчейне стоит газа. Здесь всего девять модулей и
// никаких зависимостей, поэтому проще склеить их вручную: переписать
// import/export в локальные переменные и обернуть каждый в IIFE.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'src/onchain'
const OUT_DIR = 'dist-onchain'
const OUT = join(OUT_DIR, 'index.html')
const ENTRY = 'app.js'

// Санкционный список вшивается в сборку.
//
// On-chain интерфейс не может сходить на сервер за свежим списком OFAC —
// у него нет сервера по определению. Значит список должен лежать внутри
// HTML. 127 адресов по 20 байт — 5.2 KB, около $0.006 газа.
//
// Формат: сплошная строка hex без префиксов 0x. Так на каждый адрес
// приходится ровно 40 символов, и проверка сводится к поиску подстроки с
// контролем выравнивания. Массив строк с кавычками и запятыми весил бы
// на 3 байта на адрес больше.
function loadSanctions() {
  const path = 'public/sanctions/ofac-addresses.json'
  if (!existsSync(path)) {
    throw new Error('нет ' + path + ' — сначала: node scripts/build-sanctions-list.mjs')
  }
  const json = JSON.parse(readFileSync(path, 'utf8'))
  const addrs = Object.keys(json.addresses ?? {})
  if (!addrs.length) throw new Error('список санкций пуст')

  // Проверяем формат здесь, а не в браузере: если в списке окажется адрес
  // не той длины, выравнивание по 40 символов поедет и проверка начнёт
  // врать — молча, без единой ошибки. Лучше упасть на сборке.
  for (const a of addrs) {
    if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error('плохой адрес в списке: ' + a)
  }

  return {
    hex: addrs.map((a) => a.slice(2).toLowerCase()).join(''),
    date: (json.generatedAt ?? '').slice(0, 10),
    count: addrs.length,
  }
}

const sanctions = loadSanctions()

function readModule(name) {
  const path = join(SRC, name)
  if (!existsSync(path)) throw new Error('нет модуля: ' + name)
  return readFileSync(path, 'utf8')
}

function importsOf(code) {
  const out = []
  const re = /^\s*import\s+[\s\S]*?from\s+['"]\.\/([\w.-]+)['"]/gm
  let m
  while ((m = re.exec(code))) out.push(m[1])
  return out
}

// Топологическая сортировка: сначала зависимости.
// Считаем по графу импортов, а не задаём руками — иначе при добавлении
// файла легко получить «undefined is not a function».
function order(entry) {
  const seen = new Set()
  const out = []
  const visit = (name) => {
    if (seen.has(name)) return
    seen.add(name)
    const code = readModule(name)
    for (const dep of importsOf(code)) visit(dep)
    out.push(name)
  }
  visit(entry)
  return out
}

// Переписывает модуль: import -> const, export -> запись в объект модуля.
function transform(code, name) {
  let out = code

  // import { a, b } from './x.js' -> const { a, b } = __mod_x_js
  out = out.replace(/import\s+\{([\s\S]*?)\}\s+from\s+['"]\.\/([\w.-]+)['"];?/g, (_, names, mod) => {
    const clean = names
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ')
    return `const { ${clean} } = __mod_${mod.replace(/[.-]/g, '_')};`
  })

  // export function / export const / export class -> без export,
  // но имя надо запомнить: иначе модуль экспортирует пустоту, а
  // импортирующая сторона получает undefined и падает на первом обращении.
  const exported = []
  out = out.replace(
    /^export\s+(async\s+function|function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm,
    (_, kind, nm) => {
      exported.push(nm)
      return `${kind} ${nm}`
    }
  )

  // export { a, b }
  out = out.replace(/^export\s*\{([^}]*)\};?/gm, (_, names) => {
    for (const s of names.split(',')) {
      const t = s.trim()
      if (!t) continue
      const [a, b] = t.split(/\s+as\s+/)
      exported.push(b ?? a)
    }
    return ''
  })

  if (exported.length) {
    const uniq = Array.from(new Set(exported))
    out += `\nObject.assign(__mod_${name.replace(/[.-]/g, '_')}, { ${uniq.join(', ')} });\n`
  }

  return out
}

function build() {
  const mods = order(ENTRY)
  console.log('  модулей:', mods.length)
  for (const m of mods) console.log('    -', m)

  const parts = []
  for (const m of mods) {
    let code = transform(readModule(m), m)

    // Плейсхолдеры в sanctions.js заменяются реальными данными. Делаем это
    // здесь, а не в файле-исходнике: держать в репозитории простыню на
    // 5 KB нечитаемых hex-символов бессмысленно, её всё равно пересобирает
    // скрипт обновления списка.
    code = code
      .replace("'__SANCTIONS_HEX__'", JSON.stringify(sanctions.hex))
      .replace("'__SANCTIONS_DATE__'", JSON.stringify(sanctions.date))

    const varName = '__mod_' + m.replace(/[.-]/g, '_')
    parts.push(`// ===== ${m} =====\nconst ${varName} = {};\n(function(){\n${code}\n})();`)
  }

  // Точка входа вызывается здесь, внутри той же области видимости.
  // Раньше start() стоял в HTML после бандла — то есть снаружи IIFE
  // модуля, и браузер падал с «start is not defined».
  parts.push('__mod_app_js.start();')

  return parts.join('\n\n')
}

const css = `
:root{
  --bg:#0b0e11;--card:#161b22;--card2:#1c2230;--line:#2a2f3a;
  --tx:#e6edf3;--mut:#8b949e;--acc:#f0b90b;--acc2:#d9a400;
  --ok:#3fb950;--err:#f85149;--rad:16px;
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:var(--bg);color:var(--tx);
  font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  min-height:100vh;display:flex;justify-content:center;padding:16px;
}
#app{width:100%;max-width:460px}
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;gap:8px}
.logo{font-weight:700;font-size:18px;letter-spacing:-.02em;display:flex;align-items:center;gap:8px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--acc);box-shadow:0 0 12px var(--acc)}
.badge{font-size:9px;padding:2px 6px;border-radius:5px;background:var(--acc);color:#000;font-weight:700;letter-spacing:.04em}
nav{display:flex;gap:4px;background:var(--card);padding:4px;border-radius:12px;margin-bottom:14px;border:1px solid var(--line)}
nav button{
  flex:1;background:none;border:0;color:var(--mut);padding:9px 6px;border-radius:9px;
  cursor:pointer;font-size:13px;font-weight:600;transition:.15s;font-family:inherit;
}
nav button:hover{color:var(--tx)}
nav button.active{background:var(--card2);color:var(--tx)}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--rad);padding:16px}
h2{font-size:17px;margin-bottom:10px;font-weight:700}
.row{margin-bottom:4px}
.row-label{display:flex;justify-content:space-between;font-size:12px;color:var(--mut);margin-bottom:6px;padding:0 2px}
.row-input{display:flex;align-items:center;gap:8px;background:var(--card2);border:1px solid transparent;border-radius:11px;padding:10px 12px;transition:.15s}
.row-input:focus-within{border-color:var(--acc)}
input.amt{flex:1;background:none;border:0;color:var(--tx);font-size:20px;font-weight:600;outline:none;min-width:0;font-family:inherit}
input.amt::placeholder{color:#3d444d}
.amt.out{flex:1;font-size:20px;font-weight:600;color:var(--tx);min-width:0;overflow:hidden;text-overflow:ellipsis}
select.tok{
  background:#252b36;border:0;color:var(--tx);padding:7px 9px;border-radius:9px;
  font-size:13px;font-weight:700;cursor:pointer;outline:none;font-family:inherit;
}
.arrow{display:flex;justify-content:center;margin:-4px 0;position:relative;z-index:1}
.swapdir{
  width:32px;height:32px;border-radius:9px;background:var(--card2);border:3px solid var(--card);
  color:var(--acc);cursor:pointer;font-size:15px;transition:.15s;
}
.swapdir:hover{background:var(--acc);color:#000}
.info{margin:14px 0 4px;display:flex;flex-direction:column;gap:7px}
.info-row{display:flex;justify-content:space-between;font-size:13px;gap:12px}
.info-row span:last-child{text-align:right;word-break:break-word}
.muted{color:var(--mut)}
.btn{
  width:100%;background:var(--card2);border:1px solid var(--line);color:var(--tx);
  padding:12px;border-radius:11px;font-size:14px;font-weight:600;cursor:pointer;
  margin-top:10px;transition:.15s;font-family:inherit;
}
.btn:hover:not(:disabled){border-color:var(--acc)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.primary{background:var(--acc);color:#000;border-color:var(--acc)}
.btn.primary:hover:not(:disabled){background:var(--acc2)}
.btn.wide{width:100%}
.btn.ghost{background:none;width:auto;padding:7px 11px;font-size:12px;margin:0}
.btn.small{font-size:12px;padding:7px 11px}
.slip{display:flex;align-items:center;gap:6px;margin-top:13px;flex-wrap:wrap}
.slip .muted{font-size:12px;margin-right:auto}
.chip{background:var(--card2);border:1px solid var(--line);color:var(--mut);padding:5px 10px;border-radius:7px;font-size:12px;cursor:pointer;font-weight:600;font-family:inherit}
.chip.on{background:var(--acc);color:#000;border-color:var(--acc)}
.hint{font-size:12px;color:var(--mut);margin-top:12px;line-height:1.5}
#wallet{display:flex;align-items:center;gap:8px}
.addr{font-size:12px;color:var(--mut);font-variant-numeric:tabular-nums}
#notice{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99;width:calc(100% - 32px);max-width:440px}
.notice{padding:11px 34px 11px 13px;border-radius:10px;font-size:13px;position:relative;border:1px solid var(--line);background:var(--card2);line-height:1.4}
.notice.ok{border-color:var(--ok);color:var(--ok)}
.notice.error{border-color:var(--err);color:var(--err)}
.notice-x{position:absolute;right:6px;top:50%;transform:translateY(-50%);background:none;border:0;color:inherit;font-size:19px;cursor:pointer;padding:6px;line-height:1}
.pool-list{display:flex;flex-direction:column;gap:7px;margin-top:4px}
.pool-row{display:flex;justify-content:space-between;align-items:center;background:var(--card2);border:1px solid var(--line);border-radius:11px;padding:11px 13px;cursor:pointer;transition:.15s;gap:10px}
.pool-row:hover{border-color:var(--acc)}
.pool-row.own{border-color:rgba(240,185,11,.4)}
.pool-name{display:flex;flex-direction:column;gap:4px;min-width:0}
.pool-name strong{font-size:14px}
.pool-right{display:flex;flex-direction:column;align-items:flex-end;gap:3px;font-size:11px;flex-shrink:0}
.tags{display:flex;gap:4px;flex-wrap:wrap}
.tag{font-size:9px;padding:2px 6px;border-radius:5px;background:#252b36;color:var(--mut);font-weight:700;letter-spacing:.02em}
.tag.own{background:var(--acc);color:#000}
.liq{display:flex;flex-direction:column;gap:9px;margin-top:10px}
.liq-col{display:flex;flex-direction:column;gap:5px}
.existing{background:var(--card2);border-radius:10px;padding:11px;margin-top:4px;border:1px solid var(--line)}
.existing strong{font-size:13px;display:block;margin-bottom:7px}
footer{text-align:center;font-size:11px;color:var(--mut);margin-top:18px;line-height:1.6}
.disc{color:#8b8f96;font-size:10px}
.terms{display:flex;flex-direction:column;gap:10px;margin:6px 0 14px}
.terms-item{font-size:12.5px;line-height:1.55;color:var(--mut);padding-left:11px;border-left:2px solid var(--line)}
@media(max-width:400px){body{padding:10px}.card{padding:13px}input.amt,.amt.out{font-size:18px}}
`

const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Sementsul DEX on-chain</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230b0e11'/%3E%3Ccircle cx='32' cy='32' r='13' fill='%23f0b90b'/%3E%3C/svg%3E">
<style>${css}</style>
</head>
<body>
<div id="app">
  <header>
    <div class="logo"><span class="dot"></span>Sementsul <span class="badge">ON-CHAIN</span></div>
    <div id="wallet"></div>
  </header>
  <div id="notice"></div>
  <nav>
    <button data-tab="swap" class="active">Обмен</button>
    <button data-tab="pools">Пулы</button>
    <button data-tab="liq">Ликвидность</button>
    <button data-tab="create">Создать</button>
  </nav>
  <div id="view"></div>
  <footer>
    Интерфейс хранится в блокчейне BNB Chain. Нет сервера, нет домена, нет API.<br>
    Цены читаются напрямую из пулов.<br>
    <span class="disc">__DISCLAIMER__</span>
  </footer>
</div>
<script>
(function(){
"use strict";
__BUNDLE__
})();
</script>
</body>
</html>
`

const bundle = build()

// Дисклеймер в подвале тоже подставляется из sanctions.js, чтобы текст жил
// в одном месте и не разъезжался с тем, что показывают условия.
const discMatch = readModule('sanctions.js').match(/export const DISCLAIMER =\s*\n?\s*'([^']+)'/)
if (!discMatch) throw new Error('не найден DISCLAIMER в sanctions.js')

// Замена через функцию обязательна: в коде интерфейса встречается "$'"
// (например, '$' + число), а String.replace считает $', $&, $` и $1
// спец-паттернами подстановки. С ними HTML перемешивался так, что весь
// скрипт попадал в текст страницы. Это неочевидная ловушка replace.
const out = html
  .replace('__DISCLAIMER__', () => discMatch[1])
  .replace('__BUNDLE__', () => bundle)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, out, 'utf8')

const bytes = Buffer.byteLength(out, 'utf8')
console.log('\n=== собрано ===')
console.log('  файл:', OUT)
console.log('  размер:', bytes, 'байт =', (bytes / 1024).toFixed(1), 'KB')

const buf = Buffer.from(out, 'utf8')
let zero = 0
for (const b of buf) if (b === 0) zero++
const nonZero = buf.length - zero
const dataGas = nonZero * 16 + zero * 4
const total = 21000 + dataGas
const gasPrice = 50_000_000n
const cost = Number(BigInt(total) * gasPrice) / 1e18
console.log('  газ:', total.toLocaleString('en-US'))
console.log('  стоимость:', cost.toFixed(8), 'BNB = $' + (cost * 563.5).toFixed(4))
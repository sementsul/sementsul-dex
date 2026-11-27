// Сборка страницы /chain: загрузчик интерфейса из блокчейна.
//
// Устройство. Интерфейс биржи (80 KB) лежит в calldata транзакции. Шлюзы
// вроде w3link читают только КОД контракта через eth_getCode, поэтому до
// calldata они не добираются никогда. Значит нужна тонкая прослойка,
// которая сама сделает eth_getTransactionByHash и подставит input как HTML.
//
// Почему скрипт отдельным файлом, а не встроенный. Первая версия держала
// скрипт внутри HTML, и он не запускался: на домене действует политика
// CSP со script-src 'self'. Я пробовал дать /chain свою политику — не
// вышло, Cloudflare Pages склеивает правила и отправляет ДВА заголовка
// Content-Security-Policy, а браузер применяет самый строгий. Вынести
// скрипт в файл оказалось и проще, и надёжнее: он подчиняется обычному
// script-src 'self', никаких исключений в политике не нужно.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const TX = process.argv[2] ?? '0x5b44dfe6ec24d03f39d6274ea0a0c50f0af1718c898c2ad1f8b74976251ea8c4'
const OUT_DIR = 'public/chain'

const NODES = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-rpc.publicnode.com',
  'https://1rpc.io/bnb',
  'https://bsc.drpc.org',
]

const loaderJs = `// Загрузчик интерфейса Sementsul DEX из блокчейна.
//
// Ничего не знает о бирже: читает одну транзакцию и подставляет её данные
// как HTML. Узлы перебираются по очереди, потому что публичные RPC падают
// независимо друг от друга.
(function () {
  "use strict";

  var TX = ${JSON.stringify(TX)};
  var NODES = ${JSON.stringify(NODES)};

  var s1 = document.getElementById("s1");
  var s2 = document.getElementById("s2");
  var s3 = document.getElementById("s3");
  var s4 = document.getElementById("s4");
  var bar = document.getElementById("progress");
  var det = document.getElementById("detail");
  var retry = document.getElementById("retry");

  function setStep(el, cls) {
    if (el) el.className = "step " + cls;
  }
  function progress(p) {
    if (bar) bar.style.width = p + "%";
  }
  function detail(t) {
    if (det) det.textContent = t;
  }

  function rpc(url, method, params) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () {
      ctrl.abort();
    }, 12000);
    return fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: method, params: params, id: 1 }),
      signal: ctrl.signal
    }).then(function (r) {
      clearTimeout(timer);
      return r.json();
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  // Перебор узлов: первый ответивший отдаёт данные, остальные не трогаем.
  function tryNode(n) {
    if (n >= NODES.length) {
      setStep(s1, "err");
      setStep(s2, "err");
      detail("Ни один узел не ответил. Проверьте связь и попробуйте снова.");
      if (retry) retry.style.display = "block";
      return;
    }
    var host = NODES[n].replace(/^https:\\/\\//, "");
    detail("Узел " + (n + 1) + " из " + NODES.length + ": " + host);
    progress(10 + n * 12);
    rpc(NODES[n], "eth_getTransactionByHash", [TX]).then(function (res) {
      if (res.error || !res.result || !res.result.input) {
        tryNode(n + 1);
        return;
      }
      setStep(s1, "done");
      setStep(s2, "on");
      progress(50);
      detail("Прочитано " + (res.result.input.length - 2) / 2 + " байт");
      decode(res.result.input, host);
    }).catch(function () {
      tryNode(n + 1);
    });
  }

  function decode(inputHex, host) {
    try {
      var hex = inputHex.slice(2);
      var bytes = new Uint8Array(hex.length / 2);
      for (var i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
      var text = new TextDecoder("utf-8").decode(bytes);

      setStep(s2, "done");
      setStep(s3, "on");
      progress(75);

      // Проверка целостности: это должен быть целый HTML-документ.
      // Без неё при неверном хеше транзакции мы бы подставили мусор.
      var ok = text.indexOf("<!DOCTYPE html>") === 0 && text.indexOf("</html>") > 0;
      if (!ok) {
        setStep(s3, "err");
        detail("Данные прочитаны, но это не похоже на HTML. Возможно, транзакция указана неверно.");
        if (retry) retry.style.display = "block";
        return;
      }

      setStep(s3, "done");
      setStep(s4, "on");
      progress(100);
      detail("Готово. Узел: " + host);

      setTimeout(function () {
        document.open("text/html", "replace");
        document.write(text);
        document.close();
      }, 300);
    } catch (e) {
      setStep(s3, "err");
      detail("Ошибка разбора: " + e.message);
      if (retry) retry.style.display = "block";
    }
  }

  if (retry) {
    retry.onclick = function () {
      retry.style.display = "none";
      setStep(s1, "");
      setStep(s2, "");
      setStep(s3, "");
      setStep(s4, "");
      progress(0);
      detail("");
      tryNode(0);
    };
  }

  setStep(s1, "on");
  tryNode(0);
})();
`

// Внешний CSS тоже выносим: style-src 'self' и 'unsafe-inline' вместе —
// лишнее послабление, а файл стоит один запрос.
const css = `
:root{--bg:#0b0e11;--card:#161b22;--card2:#1c2230;--line:#2a2f3a;--tx:#e6edf3;--mut:#8b949e;--acc:#f0b90b;--ok:#3fb950;--err:#f85149}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--tx);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.box{width:100%;max-width:440px;background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px}
.logo{display:flex;align-items:center;gap:9px;font-weight:700;font-size:18px;margin-bottom:18px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--acc);box-shadow:0 0 12px var(--acc)}
h1{font-size:16px;margin-bottom:8px;font-weight:700}
p{font-size:13px;color:var(--mut);line-height:1.55;margin-bottom:12px}
.step{display:flex;align-items:flex-start;gap:9px;font-size:13px;margin-bottom:9px;color:var(--mut)}
.step .n{flex-shrink:0;width:19px;height:19px;border-radius:50%;background:var(--card2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--mut)}
.step.on{color:var(--tx)}
.step.on .n{background:var(--acc);color:#000}
.step.done{color:var(--ok)}
.step.done .n{background:var(--ok);color:#000}
.step.err{color:var(--err)}
.step.err .n{background:var(--err);color:#fff}
.bar{height:3px;background:var(--card2);border-radius:2px;overflow:hidden;margin:16px 0 4px}
.bar i{display:block;height:100%;background:var(--acc);width:0;transition:width .3s;border-radius:2px}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--mut);word-break:break-all;line-height:1.5;min-height:16px}
button{width:100%;background:var(--acc);border:0;color:#000;padding:12px;border-radius:11px;font-size:14px;font-weight:700;cursor:pointer;margin-top:14px;font-family:inherit;display:none}
button:hover{background:#d9a400}
`

const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sementsul DEX — загрузка из блокчейна</title>
<link rel="icon" href="/favicon-64.png?v=${TX.slice(2, 10)}" sizes="64x64" type="image/png">
<link rel="stylesheet" href="loader.css?v=${TX.slice(2, 10)}">
</head>
<body>
<div class="box">
  <div class="logo"><span class="dot"></span>Sementsul DEX</div>
  <h1>Загрузка интерфейса из блокчейна</h1>
  <p>Интерфейс хранится в данных транзакции BNB Chain. Сейчас он будет прочитан с публичного узла и открыт.</p>

  <div class="step" id="s1"><span class="n">1</span><span>Поиск доступного узла BNB Chain</span></div>
  <div class="step" id="s2"><span class="n">2</span><span>Чтение транзакции из блокчейна</span></div>
  <div class="step" id="s3"><span class="n">3</span><span>Проверка целостности</span></div>
  <div class="step" id="s4"><span class="n">4</span><span>Открытие интерфейса</span></div>

  <div class="bar"><i id="progress"></i></div>
  <div class="mono" id="detail"></div>

  <button id="retry">Попробовать снова</button>
</div>
<script src="loader.js?v=${TX.slice(2, 10)}"></script>
</body>
</html>
`

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(join(OUT_DIR, 'loader.js'), loaderJs, 'utf8')
writeFileSync(join(OUT_DIR, 'loader.css'), css, 'utf8')
writeFileSync(join(OUT_DIR, 'index.html'), html, 'utf8')

console.log('  создано:', OUT_DIR + '/')
console.log('    index.html', Buffer.byteLength(html, 'utf8'), 'байт')
console.log('    loader.js ', Buffer.byteLength(loaderJs, 'utf8'), 'байт')
console.log('    loader.css', Buffer.byteLength(css, 'utf8'), 'байт')
console.log('  транзакция:', TX)
console.log('  узлов:', NODES.length)
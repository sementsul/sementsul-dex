// Стартовая страница: читает интерфейс из блокчейна и показывает его.
//
// Зачем это нужно. Сайт лежит в calldata транзакции, а не в коде контракта.
// Шлюзы (w3link и подобные) умеют читать только код контракта через
// eth_getCode, поэтому calldata им недоступна. Эта страница делает то же
// самое сама: берёт input транзакции и подставляет как HTML.
//
// Это не «сервер»: файл статический, никуда не ходит, кроме публичных
// RPC. Его можно скачать и открыть локально — работать будет так же.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const TX = process.argv[2] ?? '0x5b44dfe6ec24d03f39d6274ea0a0c50f0af1718c898c2ad1f8b74976251ea8c4'
const OUT_DIR = 'dist-onchain'
const OUT = join(OUT_DIR, 'start.html')

const NODES = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-rpc.publicnode.com',
  'https://1rpc.io/bnb',
  'https://bsc.drpc.org',
]

const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sementsul DEX — загрузка из блокчейна</title>
<style>
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
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--mut);word-break:break-all;line-height:1.5}
button{width:100%;background:var(--acc);border:0;color:#000;padding:12px;border-radius:11px;font-size:14px;font-weight:700;cursor:pointer;margin-top:14px;font-family:inherit;display:none}
button:hover{background:#d9a400}
a{color:var(--acc)}
</style>
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

<script>
(function(){
"use strict";
var TX = ${JSON.stringify(TX)};
var NODES = ${JSON.stringify(NODES)};

var s1=document.getElementById('s1'), s2=document.getElementById('s2'),
    s3=document.getElementById('s3'), s4=document.getElementById('s4'),
    bar=document.getElementById('progress'), det=document.getElementById('detail'),
    retry=document.getElementById('retry');

function setStep(el, cls){ el.className='step '+cls; }
function progress(p){ bar.style.width = p + '%'; }
function detail(t){ det.textContent = t; }

function rpc(url, method, params){
  var ctrl = new AbortController();
  var timer = setTimeout(function(){ ctrl.abort(); }, 12000);
  return fetch(url, {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',method:method,params:params,id:1}),
    signal: ctrl.signal
  }).then(function(r){ clearTimeout(timer); return r.json(); }).catch(function(e){ clearTimeout(timer); throw e; });
}

var idx = 0;
function tryNode(n){
  if(n >= NODES.length){
    setStep(s1,'err'); setStep(s2,'err');
    detail('Ни один узел не ответил. Проверьте связь и попробуйте снова.');
    retry.style.display='block';
    return;
  }
  var host = NODES[n].replace(/^https:\\/\\//,'');
  detail('Узел ' + (n+1) + ' из ' + NODES.length + ': ' + host);
  progress(10 + n * 10);
  rpc(NODES[n], 'eth_getTransactionByHash', [TX]).then(function(res){
    if(res.error || !res.result || !res.result.input){
      tryNode(n+1);
      return;
    }
    setStep(s1,'done');
    setStep(s2,'on');
    progress(50);
    detail('Прочитано ' + ((res.result.input.length-2)/2) + ' байт');
    decode(res.result.input, host);
  }).catch(function(){
    tryNode(n+1);
  });
}

function decode(inputHex, host){
  try{
    var hex = inputHex.slice(2);
    var bytes = new Uint8Array(hex.length/2);
    for(var i=0;i<hex.length;i+=2) bytes[i/2] = parseInt(hex.substr(i,2),16);
    var text = new TextDecoder('utf-8').decode(bytes);

    setStep(s2,'done');
    setStep(s3,'on');
    progress(75);

    // Целостность: это должен быть HTML с закрытым тегом.
    var ok = text.indexOf('<!DOCTYPE html>') === 0 && text.indexOf('</html>') > 0;
    if(!ok){
      setStep(s3,'err');
      detail('Данные прочитаны, но это не похоже на HTML. Возможно, транзакция указана неверно.');
      retry.style.display='block';
      return;
    }

    setStep(s3,'done');
    setStep(s4,'on');
    progress(100);
    detail('Готово. Открываю. Узел: ' + host);

    setTimeout(function(){
      document.open('text/html','replace');
      document.write(text);
      document.close();
    }, 350);
  }catch(e){
    setStep(s3,'err');
    detail('Ошибка разбора: ' + e.message);
    retry.style.display='block';
  }
}

retry.onclick = function(){
  retry.style.display='none';
  setStep(s1,''); setStep(s2,''); setStep(s3,''); setStep(s4,'');
  progress(0);
  detail('');
  tryNode(0);
};

setStep(s1,'on');
tryNode(0);
})();
</script>
</body>
</html>
`

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(OUT, html, 'utf8')
console.log('  создано:', OUT)
console.log('  размер:', Buffer.byteLength(html, 'utf8'), 'байт')
console.log('  транзакция:', TX)
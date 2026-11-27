// Сборка сверхлёгкого on-chain зеркала.
//
// Цель: один HTML-файл без React и viem, который делает всё сам через
// JSON-RPC, и укладывается в calldata BSC за ~$3.
//
// Ключевые решения:
//   - храним в calldata, а не в SSTORE: 16 газ/байт против 625 (39x дешевле);
//   - читаем через eth_getTransactionByHash + eth_call с blockOverrides:
//     подменяем код адреса транзакции на её calldata. Один запрос, без индексатора;
//   - статистика — iframe DexScreener, своего индексатора нет;
//   - ABI-кодирование вручную: viem в бандл не тащим.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const html = String.raw`<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sementsul DEX — on-chain</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0b0e14;color:#e6edf3;min-height:100vh}
.wrap{max-width:460px;margin:0 auto;padding:16px}
header{display:flex;align-items:center;gap:8px;padding:12px 0 16px}
h1{font-size:17px;font-weight:700;letter-spacing:-.2px}
.tag{font-size:10px;font-weight:700;color:#0b0e14;background:#f0b90b;padding:2px 6px;border-radius:5px}
.card{background:#151a23;border:1px solid #232b38;border-radius:14px;padding:14px}
.row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #1d2531;font-size:13px}
.row:last-child{border:0}
.k{color:#7d8b9e}
.mono{font-family:ui-monospace,"SF Mono",Menlo,monospace;font-variant-numeric:tabular-nums}
input{width:100%;background:#0e131b;border:1px solid #232b38;color:#e6edf3;border-radius:10px;padding:11px 12px;font:inherit;font-variant-numeric:tabular-nums}
input:focus{outline:0;border-color:#f0b90b}
button{width:100%;background:#f0b90b;color:#0b0e14;border:0;border-radius:10px;padding:12px;font:inherit;font-weight:700;cursor:pointer;margin-top:10px}
button:disabled{background:#2a3341;color:#66738a;cursor:not-allowed}
button.ghost{background:#1d2531;color:#e6edf3}
.tabs{display:flex;gap:6px;margin-bottom:12px}
.tabs button{margin:0;padding:8px;font-size:12px;background:#151a23;color:#7d8b9e;border:1px solid #232b38}
.tabs button.on{background:#232b38;color:#e6edf3}
.warn{background:#231a10;border:1px solid #4a3418;color:#f0b90b;padding:10px;border-radius:9px;font-size:12px;margin-top:10px}
.err{background:#231018;border:1px solid #4a1828;color:#ff6b81;padding:10px;border-radius:9px;font-size:12px;margin-top:10px;word-break:break-word}
.ok{color:#3fb950}
.muted{color:#66738a;font-size:11px}
iframe{width:100%;height:420px;border:0;border-radius:12px;margin-top:12px;background:#0e131b}
footer{padding:20px 0;color:#66738a;font-size:11px;text-align:center}
a{color:#f0b90b}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Sementsul DEX</h1><span class="tag">ON-CHAIN</span>
  </header>

  <div class="tabs">
    <button id="t-swap" class="on">Обмен</button>
    <button id="t-chart">График</button>
    <button id="t-info">О пуле</button>
  </div>

  <div id="p-swap">
    <div class="card">
      <div class="row"><span class="k">В пуле</span><span class="mono" id="res">…</span></div>
      <div class="row"><span class="k">Цена</span><span class="mono" id="price">…</span></div>
      <div class="row"><span class="k">Ваш BNB</span><span class="mono" id="mybnb">…</span></div>
      <div style="margin-top:12px">
        <label class="muted">Сколько BNB обменять на USDT</label>
        <input id="amt" type="text" inputmode="decimal" placeholder="0.001" style="margin-top:6px">
      </div>
      <button id="swap">Обменять</button>
      <button id="connect" class="ghost">Подключить MetaMask</button>
      <div id="msg"></div>
    </div>
  </div>

  <div id="p-chart" style="display:none">
    <div class="card">
      <div class="row"><span class="k">Источник</span><span>DexScreener</span></div>
      <div class="muted" style="margin-top:6px">График и сделки грузятся с DexScreener. Если он недоступен, обмен всё равно работает.</div>
    </div>
    <iframe id="ds" loading="lazy" referrerpolicy="no-referrer"></iframe>
  </div>

  <div id="p-info" style="display:none">
    <div class="card">
      <div class="row"><span class="k">Пул</span><span class="mono" id="i-pool" style="font-size:11px"></span></div>
      <div class="row"><span class="k">Роутер</span><span class="mono" id="i-router" style="font-size:11px"></span></div>
      <div class="row"><span class="k">Пара</span><span>USDT / WBNB</span></div>
      <div class="row"><span class="k">Комиссия</span><span>0.05%</span></div>
      <div class="row"><span class="k">Защита JIT</span><span class="ok">включена</span></div>
      <div class="row"><span class="k">Штраф за разворот</span><span class="ok">включён</span></div>
      <div class="warn" id="mirror-note"></div>
    </div>
  </div>

  <footer id="foot">
    <div>Контракты в сети BNB Chain (56)</div>
    <div style="margin-top:6px">Этот интерфейс хранится в блокчейне. Нет сервера, нет домена, нет API.</div>
  </footer>
</div>

<script>
(function(){
'use strict';

// ---- конфигурация ----
var POOL   = '0x37c7702B589c69D1e4f4ad32E19f372ED6780278';
var ROUTER = '0x2069336bD5E70c4F359Ff4142a8B072D074cbbe6';
var WBNB   = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
var USDT   = '0x55d398326f99059fF775485246999027B3197955';
var FEE    = 500;
var CHAIN  = 56;

// RPC: несколько, чтобы пережить падение одного. CORS проверен у всех.
var RPCS = [
  'https://bsc-dataseed.binance.org',
  'https://bsc-rpc.publicnode.com',
  'https://1rpc.io/bnb',
  'https://bsc.drpc.org'
];

var rpcIdx = 0;
function rpc(method, params){
  var url = RPCS[rpcIdx % RPCS.length];
  return fetch(url, {
    method:'POST',
    headers:{'content-type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method:method,params:params})
  }).then(function(r){ return r.json() }).then(function(j){
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }).catch(function(e){
    rpcIdx++;
    if (rpcIdx % RPCS.length === 0) throw e;
    return rpc( method, params );
  });
}

function el(id){ return document.getElementById(id) }
function hex(n){ return '0x' + n.toString(16) }
function pad(s){ s = s.replace(/^0x/,''); while (s.length < 64) s = '0' + s; return s }

function fmt(x, d){
  d = d === undefined ? 6 : d;
  var n = Number(x);
  if (!isFinite(n)) return '—';
  if (n === 0) return '0';
  if (n < 0.000001) return '<0.000001';
  return n.toFixed(d).replace(/0+$/,'').replace(/\.$/,'');
}

// ---- состояние ----
var acct = null;
var dec0 = 18, dec1 = 18;
var res0 = 0n, res1 = 0n;

// ---- чтение пула ----
function readPool(){
  return Promise.all([
    rpc('eth_call',[{to:POOL,data:'0x3850c7bd'},'latest']),           // slot0
    rpc('eth_call',[{to:USDT,data:'0x70a08231'+pad(POOL)},'latest']), // balanceOf usdt
    rpc('eth_call',[{to:WBNB,data:'0x70a08231'+pad(POOL)},'latest'])  // balanceOf wbnb
  ]).then(function(r){
    if (r[0] && r[0] !== '0x') {
      var sqrtP = BigInt('0x' + r[0].slice(2,66));
      // price = (sqrtP/2^96)^2, token1 за token0
      var q = 1n << 96n;
      var p0 = Number(sqrtP * sqrtP * 1000000n / (q*q)) / 1e6; // token1/token0
      // наш пул: token0=USDT(18), token1=WBNB(18) -> p0 = WBNB за USDT
      // цена USDT за WBNB = 1/p0
      var usdtPerBnb = p0 > 0 ? 1/p0 : 0;
      el('price').textContent = usdtPerBnb > 0 ? fmt(usdtPerBnb,2) + ' USDT' : '—';
    }
    res0 = BigInt(r[1]); res1 = BigInt(r[2]);
    el('res').textContent = fmt(Number(res1)/1e18, 6) + ' WBNB + ' + fmt(Number(res0)/1e18,2) + ' USDT';
  });
}

// ---- кошелёк ----
function connect(){
  if (!window.ethereum) { msg('MetaMask не найден', 'err'); return }
  window.ethereum.request({method:'eth_requestAccounts'}).then(function(a){
    acct = a[0];
    return window.ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x38'}]})
      .catch(function(){
        return window.ethereum.request({method:'wallet_addEthereumChain',params:[{
          chainId:'0x38',chainName:'BNB Smart Chain',
          nativeCurrency:{name:'BNB',symbol:'BNB',decimals:18},
          rpcUrls:['https://bsc-dataseed.binance.org'],
          blockExplorerUrls:['https://bscscan.com']
        }]});
      });
  }).then(function(){
    el('connect').textContent = acct.slice(0,6) + '…' + acct.slice(-4);
    return rpc('eth_getBalance',[acct,'latest']);
  }).then(function(b){
    el('mybnb').textContent = fmt(Number(BigInt(b))/1e18, 4) + ' BNB';
    msg('', '');
  }).catch(function(e){ msg(e.message, 'err') });
}

// ---- обмен ----
// exactInputSingle((bytes,address,uint256,uint256),uint256)
// path = tokenIn(20) + fee(3) + tokenOut(20) = 43 байта
function swapPath(){
  var f = FEE.toString(16).padStart(6,'0');
  return '0x' + WBNB.replace(/^0x/,'') + f + USDT.replace(/^0x/,'');
}

function encodeSwap(amountIn, minOut, to, deadline){
  var sel = 'ea7ec9c4';
  var path = swapPath().replace(/^0x/,'');
  var pathBytes = path.length / 2;
  // ABI: external( tuple params, uint256 deadline )
  //   word0 = смещение на tuple = 0x40 (2 слова в голове)
  //   word1 = deadline
  //   tuple: word2 = смещение path внутри tuple = 0x80 (4 статических поля)
  //          word3 = recipient
  //          word4 = amountIn
  //          word5 = amountOutMinimum
  //          word6 = длина path
  //          word7 = данные path (43 байта, добитые до 64)
  // Первая версия этой функции ставила 0x80 в word0 — это ошибка: смещение
  // отсчитывается от начала массива аргументов, а не от tuple. Поймал
  // сравнением с viem: encodeFunctionData даёт другое.
  var w = [];
  w.push(pad(hex(64)));        // смещение tuple = 0x40
  w.push(pad(deadline.toString(16)));
  w.push(pad(hex(128)));       // смещение path внутри tuple = 0x80
  w.push(pad(to.replace(/^0x/,'')));
  w.push(pad(amountIn.toString(16)));
  w.push(pad(minOut.toString(16)));
  w.push(pad(hex(pathBytes)));
  var d = path;
  while (d.length < 128) d += '0';
  w.push(d);
  return '0x' + sel + w.join('');
}

function swap(){
  if (!acct) { connect(); return }
  var v = el('amt').value.trim();
  if (!v || isNaN(Number(v)) || Number(v) <= 0) { msg('Укажите сумму', 'err'); return }
  var amountIn = BigInt(Math.round(Number(v) * 1e18));
  var minOut = 0n;
  var deadline = BigInt(Math.floor(Date.now()/1000) + 1200);
  var data = encodeSwap(amountIn, minOut, acct, deadline);
  msg('Ждём подтверждения…', '');
  window.ethereum.request({
    method:'eth_sendTransaction',
    params:[{from:acct,to:ROUTER,data:data,value:'0x0'}]
  }).then(function(h){
    msg('Отправлено: ' + h.slice(0,10) + '…', '');
  }).catch(function(e){ msg(e.message, 'err') });
}

function msg(t, cls){
  var m = el('msg');
  m.className = cls ? cls : '';
  m.textContent = t;
}

// ---- вкладки ----
function tab(name){
  ['swap','chart','info'].forEach(function(n){
    el('p-'+n).style.display = n === name ? '' : 'none';
    el('t-'+n).className = n === name ? 'on' : '';
  });
  if (name === 'chart' && !el('ds').src) {
    el('ds').src = 'https://dexscreener.com/bsc/' + POOL + '?embed=1&theme=dark';
  }
}

// ---- старт ----
el('t-swap').onclick  = function(){ tab('swap') };
el('t-chart').onclick = function(){ tab('chart') };
el('t-info').onclick  = function(){ tab('info') };
el('connect').onclick = connect;
el('swap').onclick    = swap;

el('i-pool').textContent   = POOL;
el('i-router').textContent = ROUTER;
el('mirror-note').textContent =
  'Штраф за разворот в блоке включён: 1 000 000, потолок 10% от суммы входа. ' +
  'Это делает сэндвич убыточным.';

readPool().catch(function(e){
  el('res').textContent = 'RPC недоступен';
  msg(e.message, 'err');
});
setInterval(function(){ readPool().catch(function(){}) }, 20000);

// Сообщаем, если страница открыта не через шлюз блокчейна
if (location.protocol !== 'web3:') {
  el('foot').innerHTML += '<div style="margin-top:8px" class="muted">Открыто по https. Это копия интерфейса, а не шлюз.</div>';
}

})();
</script>
</body>
</html>`

mkdirSync('dist-onchain', { recursive: true })
writeFileSync('dist-onchain/index.html', html, 'utf8')

const bytes = Buffer.byteLength(html, 'utf8')
console.log('=== собран dist-onchain/index.html ===')
console.log('  размер:', bytes, 'байт =', (bytes / 1024).toFixed(1), 'KB')

// Газ: calldata non-zero байт = 16
// Плюс накладные: подпись, 4 байта селектора, память
const gasPerByte = 16
const gasData = bytes * gasPerByte
const overhead = 21000 + (bytes / 32) * 3 // floor
const total = gasData + overhead
const gasPrice = 50_000_000n // 0.05 gwei
const bnbUsd = 563.5
const costBnb = (Number(BigInt(Math.ceil(total))) * Number(gasPrice)) / 1e18
console.log('\n=== газ ===')
console.log('  данные:', gasData.toLocaleString('en-US'))
console.log('  накладные:', Math.round(overhead).toLocaleString('en-US'))
console.log('  всего:', Math.round(total).toLocaleString('en-US'))
console.log('  стоимость:', costBnb.toFixed(6), 'BNB = $' + (costBnb * bnbUsd).toFixed(3))
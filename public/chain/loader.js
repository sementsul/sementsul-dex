// Загрузчик интерфейса Sementsul DEX из блокчейна.
//
// Ничего не знает о бирже: читает одну транзакцию и подставляет её данные
// как HTML. Узлы перебираются по очереди, потому что публичные RPC падают
// независимо друг от друга.
(function () {
  "use strict";

  var TX = "0x9cac9fc5ce962bc477a233afe5004739f5bf15a775abfa8d2844e463401cd15c";
  var NODES = ["https://bsc-dataseed.binance.org","https://bsc-rpc.publicnode.com","https://1rpc.io/bnb","https://bsc.drpc.org"];

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
    var host = NODES[n].replace(/^https:\/\//, "");
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

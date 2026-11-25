// Экономика JIT-бота при вестинге комиссий.
//
// Вопрос, на который отвечает скрипт: если бот вынужден держать позицию
// T секунд, при какой T его ожидаемая прибыль становится отрицательной?
//
// Логика. Бот входит ликвидностью L_bot против честной L_honest и забирает
// долю комиссии, равную своей доле ликвидности:
//
//     profit = fee * swap * L_bot / (L_bot + L_honest)
//
// Пока держит позицию, он несёт риск цены на ВЕСЬ свой номинал. Номинал
// позиции в диапазоне шириной w вокруг цены примерно равен:
//
//     notional = L_bot * w
//
// а риск за время T при волатильности sigma (годовой) — это sigma*sqrt(T/T_year)
// от номинала. Значит:
//
//     risk = sigma * sqrt(T / T_year) * L_bot * w
//
// Отношение прибыли к риску:
//
//     profit/risk = fee * swap / (sigma * sqrt(T/T_year) * w * (L_bot + L_honest))
//
// Важное следствие: L_bot сокращается. То есть РАЗМЕР БОТА НЕ ВАЖЕН — крупный
// бот берёт больше комиссии, но ровно во столько же раз больше рискует.
// Единственные рычаги — время удержания T и ширина диапазона w.

const BLOCK_SECONDS = 0.448; // измерено на BSC, 29 замеров
const YEAR_SECONDS = 365 * 24 * 3600;

// Годовая волатильность. BNB исторически 50-80%; для «спокойного» рынка
// берём 40%, для турбулентного 100%.
const VOLS = [
  { label: 'спокойный рынок', sigma: 0.4 },
  { label: 'обычный BNB', sigma: 0.6 },
  { label: 'турбулентный', sigma: 1.0 },
];

// Сценарии свопа. fee — комиссия пула (доля), swap — размер свопа в USD,
// w — ширина диапазона как доля цены (0.02 = ±1%).
const SCENARIOS = [
  { label: 'мелкий своп $1k, узкий ±1%', fee: 0.0025, swap: 1000, w: 0.02 },
  { label: 'средний своп $10k, узкий ±1%', fee: 0.0025, swap: 10000, w: 0.02 },
  { label: 'крупный своп $100k, ±1%', fee: 0.0025, swap: 100000, w: 0.02 },
  { label: 'крупный своп $100k, широкий ±10%', fee: 0.0025, swap: 100000, w: 0.2 },
  { label: 'наша комиссия 0.05%, $10k, ±1%', fee: 0.0005, swap: 10000, w: 0.02 },
  { label: 'наша комиссия 0.005%, $10k, ±1%', fee: 0.00005, swap: 10000, w: 0.02 },
];

// Доля комиссии, которую забирает бот при отношении L_bot/L_honest = 10.
const BOT_SHARE = 10 / 11; // = 0.909, измерено в Foundry-тесте

function riskPerSecond(sigma, w, notional) {
  // sigma*sqrt(T/T_year)*notional; берём производную-эквивалент для T=1с.
  return sigma * Math.sqrt(1 / YEAR_SECONDS) * w * notional;
}

console.log('=== Сколько блоков нужно, чтобы JIT перестал быть выгодным ===');
console.log('(блок BSC = 0.448 с, доля бота 90.9% как в замере)\n');

for (const sc of SCENARIOS) {
  console.log(`--- ${sc.label} ---`);
  // Номинал бота: подбираем так, чтобы он был сопоставим со свопом.
  // Для доли 90.9% бот в 10 раз крупнее честного LP, и его номинал
  // пропорционален размеру свопа (иначе он не «перекрывает» проскальзывание).
  const notional = sc.swap * 10;

  const profit = sc.fee * sc.swap * BOT_SHARE;

  for (const v of VOLS) {
    // Ищем T, при котором риск == прибыль.
    // profit = sigma*sqrt(T/Y)*w*notional  =>
    // sqrt(T/Y) = profit/(sigma*w*notional)
    const ratio = profit / (v.sigma * sc.w * notional);
    const tSeconds = ratio * ratio * YEAR_SECONDS;
    const blocks = Math.ceil(tSeconds / BLOCK_SECONDS);

    const human =
      tSeconds < 60
        ? `${tSeconds.toFixed(1)} с`
        : tSeconds < 3600
          ? `${(tSeconds / 60).toFixed(1)} мин`
          : tSeconds < 86400
            ? `${(tSeconds / 3600).toFixed(1)} ч`
            : `${(tSeconds / 86400).toFixed(1)} сут`;

    console.log(
      `  ${v.label.padEnd(16)} прибыль $${profit.toFixed(2).padStart(8)}  ` +
        `безубыток через ${human.padStart(9)}  = ${blocks} блоков`
    );
  }
  console.log('');
}

console.log('=== Вывод ===');
console.log('Порог сильно зависит от размера свопа и ширины диапазона:');
console.log('крупный своп в узком диапазоне окупает даже долгое удержание.');
console.log('Поэтому «одна задержка на все случаи» не работает — нужна');
console.log('шкала, привязанная к тому, сколько бот на самом деле рискует.');
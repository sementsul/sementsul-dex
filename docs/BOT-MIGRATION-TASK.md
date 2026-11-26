# Перевод `lp-ladder` на пул Sementsul

Задание для сессии, которая будет править бота. Всё проверено на цепи BSC
(chainId 56). Проверки воспроизводимы скриптами из этого же репозитория —
ссылки в конце.

Читать целиком перед первой правкой: три из пяти пунктов ломаются молча, без
ошибки в логах.

> **Статус на 2026-11-26: дефект исправлен, пул пересоздан, переключать можно.**
>
> В прежнем пуле `0x3688726E…` был дефект: первый минт в новый диапазон, когда
> в пуле накоплены комиссии, записывал позиции неверный снимок комиссии. После
> этого `collect` и `burn` падали с `panic 0x11`, и позиция запиралась.
>
> Дефект исправлен в коде, фабрика и роутер передеплоены, новый пул —
> `0x37c7702B…` (адреса ниже). Подтверждено на живой сети: минт, начисление
> комиссий, `collect` после вестинга и вывод работают.
>
> Разбор, доказательство и 6 регрессионных тестов —
> [POOL-STUCK-POSITION-BUG.md](./POOL-STUCK-POSITION-BUG.md).
>
> Старый пул `0x3688726E…` остаётся на цепи, но пользоваться им не нужно: в нём
> навсегда заперта одна позиция бота на 0.105 USDT.

> **Что уже сделано в этой сессии (не переделывать):**
>
> - Кошелёк бота `0x922598c9D529836b4b475cE74188D5EeFFb83a88` пополнен:
>   **134.536 USDT + 0.001854 WBNB + 0.012898 BNB**. Это стартовый капитал под
>   новый пул, переводить ничего не нужно.
> - В старом пуле осталось 0.105 USDT — они заперты дефектом и недоступны.
>   Списывать их со счетов.
> - Наш индексатор научен разбирать V3-свопы; история по новому пулу уже
>   пишется. Блок «Последние сделки» на сайте показывает сделки нашего пула.
>
> **Что осталось на стороне бота — и чего у этой сессии нет:**
>
> - Приватного ключа бота здесь нет (`BOT_PRIVATE_KEY` отсутствует в `.env`).
>   Всё, что требует подписи от адреса бота, делать в сессии, где этот ключ
>   есть. Ключ специально не искали.
> - Вместе с USDT на адрес бота ушли **899 999 999.9 SEM** — случайно, из-за
>   бага в `withdraw.mjs` (см. раздел 10). Это бесполезный тестовый токен,
>   снятый с биржи. Вернуть его нельзя: нужен ключ бота. Ни на что не влияет,
>   но пусть будет известно, чтобы сессия не приняла его за рабочий баланс.
> - В старом пуле осталось 0.105 USDT — они заперты дефектом и недоступны.
>   Списывать их со счетов.

---

## Коротко, что менять

| # | Что | Риск |
|---|---|---|
| 1 | `POOL_ADDRESS` → наш пул | безопасно, но мало: даёт только чтение ликвидности |
| 2 | `slot0` декодируется 7 полями → надо 5 | падение чтения состояния |
| 3 | `mint`/`burn`/`collect` идут в NFT-менеджер → надо в пул | **главная работа** |
| 4 | `exactInputSingle` 7 полей → надо 4 | падение всех свопов |
| 5 | Вестинг 1150 блоков | комиссии сгорают при частых перестановках |

Хорошая новость: **порядок токенов и формула тиков у бота уже правильные** —
они совпадают с нашими. Это подтверждено, менять не нужно.

---

## 1. Что такое наш пул

```
Адрес:        0x37c7702B589c69D1e4f4ad32E19f372ED6780278
token0:       USDT   0x55d398326f99059fF775485246999027B3197955
token1:       WBNB   0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c
fee:          500  (0.05%)
tickSpacing:  10
Фабрика:      0xc0b597bee57bba0aae2ce9e73e83217331a24dd9
Роутер V3:    0xf98b7f4effb34dae1f785010ecf71ff796e7fdd1
```

Пул и фабрика пересозданы 2026-11-26: в прежнем пуле
`0x3688726E…` был дефект, запирающий первую позицию в новом диапазоне тиков
(см. [POOL-STUCK-POSITION-BUG.md](./POOL-STUCK-POSITION-BUG.md)). Если вы
видели этот документ раньше — адреса в нём были другие, берите эти.

### Порядок токенов совпадает с текущим пулом бота

Проверено: и у Pancake-пула `0x36696169...` (который бот использует сейчас), и
у нашего — **token0 = USDT, token1 = WBNB**. Значит переворачивать ничего не
надо, и `zeroForOne` считается одинаково.

### Формула тиков у бота уже верная

```js
// ticksForLevel в боте:
const lower = alignTick(tickFromPrice(1 / hi), spacing, -1)
const upper = alignTick(tickFromPrice(1 / lo), spacing, 1)
```

Она уже инвертирует цену, потому что цена в пуле — WBNB за USDT. Проверка для
`level=556, pct=5, spacing=10`:

```
lo = 528.20, hi = 583.80 USDT за WBNB
lower = -63700  → 583.87 USDT за WBNB   (нижний тик = ВЕРХНЯЯ цена)
upper = -62690  → 527.78 USDT за WBNB   (верхний тик = НИЖНЯЯ цена)
```

Это правильно и для нашего пула. **Эту часть трогать не нужно.**

---

## 2. Первое, что сломается: `slot0` из 5 полей

Бот объявляет:

```js
pool: [{ name: "slot0", ..., outputs: [
  { name: "sqrtPriceX96", type: "uint160" },
  { name: "tick", type: "int24" },
  { name: "observationIndex", type: "uint16" },       // ← у нас этого нет
  { name: "observationCardinality", type: "uint16" }, // ← нет
  { name: "observationCardinalityNext", type: "uint16" }, // ← нет
  { name: "feeProtocol", type: "uint8" },             // ← нет
  { name: "unlocked", type: "bool" }                  // ← нет
]}]
```

У нас возвращается **пять** полей:

```js
{ name: 'sqrtPriceX96_', type: 'uint160' },
{ name: 'tick_',         type: 'int24'  },
{ name: 'liquidity_',    type: 'uint128' },
{ name: 'fee_',          type: 'uint24' },
{ name: 'tickSpacing_',  type: 'int24'  },
```

Что произойдёт при старом ABI: декодер попытается прочитать 7 слов из ответа
длиной 5 слов. Viem бросит `AbiDecodingDataSizeTooSmallError`. Если где-то
стоит `catch` — состояние молча станет `null`.

**Правка.** Взять ABI пула из `sementsul-dex/src/contracts/artifacts.json`,
ключ `SementsulV3Pool.abi`. Не писать ABI руками: в нём 30+ функций, и
единственный источник правды — артефакт компилятора.

### Важно: цена читается из ДРУГОГО пула

Сейчас в боте:

```js
const POOL = (env.POOL_ADDRESS || ADDR.pool).toLowerCase()   // где у нас ликвидность
const REF_POOL = (env.REF_POOL || ADDR.refPool || POOL).toLowerCase() // откуда цена
```

`slot0` берётся из `REF_POOL`, а из `POOL` — только `liquidity()`. То есть
смена `POOL_ADDRESS` **не переключит бота на наш пул целиком**.

Так и было задумано: цена бралась из самого глубокого пула Pancake (0.01%), чтобы
решения принимались по рынку, а не по тонкому собственному пулу.

**Решение, которое надо принять явно.** Есть два варианта:

- **Оставить `REF_POOL` = Pancake 0.01%** (`0x172fcD41E0913e95784454622d1c3724f546f849`).
  Бот принимает решения по рыночной цене, а ликвидность держит у нас. Это
  разумно, пока наш пул тонкий: иначе он будет ориентироваться на цену,
  которую сам же и сдвигает.
- **Поставить `REF_POOL` = наш пул.** Тогда бот видит только нас. На тонком
  пуле это плохо: любая своя сделка сдвигает цену, и следующее решение
  принимается по сдвинутой.

Рекомендация: **оставить `REF_POOL` на Pancake**, поменять только
`POOL_ADDRESS`. Когда в нашем пуле будет сравнимая глубина — переключить.

---

## 3. Главная работа: у нас нет NFT

Бот работает через `ADDR.npm = 0x46A15B0b27311cedF172AB29E4f4766fbE7F4364`
(`NonfungiblePositionManager` Pancake). У нас такого контракта нет и не будет.

### Как устроена позиция

```
key = keccak256(abi.encodePacked(owner, int24 tickLower, int24 tickUpper))
```

Именно `encodePacked`. Если использовать `encode` — ключ другой, `positions()`
вернёт нули **без ошибки**. Проверено на цепи: `encodePacked` даёт позицию с
`liquidity = 414849099700137305309`, `encode` — нули.

### Соответствие вызовов

| Бот сейчас | Надо |
|---|---|
| `npm.mint(params)` → tokenId | `pool.mint(recipient, tickLower, tickUpper, L)` |
| `npm.increaseLiquidity({tokenId, ...})` | `pool.mint(...)` с теми же тиками |
| `npm.decreaseLiquidity({tokenId, liquidity})` | `pool.burn(tickLower, tickUpper, L)` |
| `npm.collect({tokenId, recipient, ...})` | `pool.collect(recipient, tickLower, tickUpper, max0, max1)` |
| `npm.burn(tokenId)` | нет аналога: `burn` с `L = вся позиция` |
| `npm.positions(tokenId)` | `pool.positions(key)` |
| `npm.tokenOfOwnerByIndex(me, i)` | нет аналога — см. ниже |
| `npm.balanceOf(me)` | нет аналога |

### Точные сигнатуры

```solidity
// Открыть или добавить. Возвращает (amount0, amount1) — сколько пул списал.
function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount)
    external returns (uint256 amount0, uint256 amount1);

// Снять. Возвращает (amount0, amount1) — сколько освободилось.
function burn(int24 tickLower, int24 tickUpper, uint128 amount)
    external returns (uint256 amount0, uint256 amount1);

// Забрать комиссии. Возвращает (amount0, amount1) — сколько переведено.
function collect(address recipient, int24 tickLower, int24 tickUpper,
                 uint128 amount0Requested, uint128 amount1Requested)
    external returns (uint128 amount0, uint128 amount1);
```

Обратите внимание: `mint`/`burn` **не переводят токены сами**. Они только
меняют учёт. Схема как в Uniswap:

1. `mint` — пул списывает `amount0`/`amount1` с вызывающего через
   `transferFrom`, поэтому нужен `approve` **на адрес пула**;
2. `burn` — токены остаются в пуле, но перестают быть ликвидностью;
3. `collect` — вот он переводит их на `recipient`.

Значит `burn` без `collect` не отдаст ничего. В боте сейчас
`decreaseLiquidity` + `collect` идут парой — эту логику надо сохранить.

### Нет перечисления позиций

`tokenOfOwnerByIndex` у нас отсутствует. Позиция не «принадлежит списку», она
вычисляется из тройки `(owner, lower, upper)`.

**Что делать с таблицей `positions`.** Сейчас:

```sql
CREATE TABLE IF NOT EXISTS positions (
  token_id   TEXT PRIMARY KEY,
  level      REAL NOT NULL,
  pct        REAL NOT NULL,
  budget     REAL NOT NULL,
  lower      INTEGER NOT NULL,
  upper      INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  closed     INTEGER NOT NULL DEFAULT 0
);
```

`lower` и `upper` уже есть — значит ключ вычисляется из строки без обращения к
цепи. Правка минимальная: перестать полагаться на `token_id` как на
идентификатор и перейти на составной ключ.

Вариант, который не ломает существующие данные:

```sql
-- token_id остаётся, но заполняется нашим ключом:
--   token_id = keccak256(abi.encodePacked(owner, lower, upper))
-- Тогда PRIMARY KEY продолжает работать, а смысл поля меняется.
```

Если в базе уже есть записи Pancake с настоящими `tokenId` — их надо либо
пометить `closed = 1`, либо перенести отдельно: смешивать два вида
идентификаторов в одном поле опасно.

### Где в коде это живёт

```
makeChain() внутри
  mintPosition({ lower, upper, amount0, amount1 })
  increase(tokenId, deltaL, amount0, amount1)
  decrease(tokenId, liq)
  collect(tokenId)
  burn(tokenId)
  readPosition(tokenId)      → buildPosition(tokenId, p, fees, st)
  myTokens()                 → перебор tokenOfOwnerByIndex
  snapshot()                 → читает npm.balanceOf + перечисляет
```

Все они идут в `ADDR.npm`. После правки `ADDR.npm` не нужен вообще — вместо
него `POOL`.

`buildPosition` разбирает ответ `npm.positions(tokenId)` по индексам:
`p[5]` = tickLower, `p[6]` = tickUpper, `p[7]` = liquidity, `p[10]` =
tokensOwed0. У `pool.positions(key)` раскладка **другая**:

```
[0] liquidity
[1] feeGrowthInside0LastX128
[2] feeGrowthInside1LastX128
[3] tokensOwed0
[4] tokensOwed1
[5] pending0
[6] pending1
[7] vestBlock
```

То есть `p[5]` в старом коде — это `tickLower`, а в новом будет `pending0`.
Если не переписать индексы, бот прочитает мусор и не заметит.

---

## 4. Свопы: сигнатура роутера другая

Бот объявляет `exactInputSingle` с **семью** полями:

```js
{ name: "exactInputSingle", inputs: [{ name: "params", type: "tuple", components: [
  { name: "tokenIn", type: "address" },
  { name: "tokenOut", type: "address" },
  { name: "fee", type: "uint24" },
  { name: "recipient", type: "address" },
  { name: "amountIn", type: "uint256" },
  { name: "amountOutMinimum", type: "uint256" },
  { name: "sqrtPriceLimitX96", type: "uint160" }
]}]}
```

У нашего роутера **четыре** поля, а маршрут упакован в `bytes path`:

```js
struct ExactInputParams {
    bytes path;          // token(20) + fee(3) + token(20)
    address recipient;
    uint256 amountIn;
    uint256 amountOutMinimum;
}
function exactInputSingle(ExactInputParams memory params, uint256 deadline)
```

Селекторы:

```
наш:      0xea7ec9c4   exactInputSingle((bytes,address,uint256,uint256),uint256)
Pancake:  0x414bf389   8 полей
бот:      0x04e45aaf   7 полей без deadline
```

Три разные формы. Отправка calldata бота нашему роутеру упадёт на селекторе с
`Execution reverted for an unknown reason` — без внятной причины, потому что
функции с таким селектором там просто нет.

Отдельно обратите внимание: **в форме бота нет `deadline`**, а наш роутер его
требует вторым аргументом. Просто «переложить поля» не получится — надо
добавить аргумент.

### Как собрать `path`

```
path = tokenIn (20 байт) + fee (3 байта big-endian) + tokenOut (20 байт)
```

Для одного шага длина ровно **43 байта** — контракт проверяет:
`require(params.path.length == 43, 'SementsulRouter: NOT_SINGLE')`.

```js
const path = tokenIn.toLowerCase().slice(2)
  + fee.toString(16).padStart(6, '0')
  + tokenOut.toLowerCase().slice(2)
```

### Подводный камень в раскладке calldata

Если собирать вручную (а бот использует `encodeFunctionData`, так что ему
достаточно правильного ABI), есть ловушка: **смещение на tuple равно `0x40`,
а не `0x20`**, потому что в голове два слова — смещение и `deadline`.

Я на этом уже ошибся: собрал `0x20`, получил откат при формально верном
селекторе. Проверяется сравнением с эталоном `encodeFunctionData` из viem
байт в байт.

**Рекомендация:** не собирать calldata руками. Взять ABI роутера из
`artifacts.json` (`SementsulV3Router.abi`) и отдать `encodeFunctionData` —
тогда раскладка будет верной по построению.

### Имена отличаются

| У нас | У Pancake |
|---|---|
| `refundBNB()` `0xf37050da` | `refundETH()` `0x12210e8a` |
| `unwrapWBNB(uint256,address)` `0x9d110e71` | `unwrapWETH9(...)` `0x49404b7c` |

Совпадает: `multicall(bytes[])` `0xac9650d8`, `exactInput`, `exactOutput`,
`exactOutputSingle`.

### Вход в BNB не работает

Если бот когда-нибудь захочет торговать из нативного BNB — сейчас это
невозможно. Роутер платит через `transferFrom(payer, ...)`, где
`payer = msg.sender`; внутри `multicall` это пользователь, а не роутер, и он
пытается списать WBNB с того, кто прислал BNB.

Проверено: с выданным `approve` на WBNB тот же calldata проходит. Нужна правка
контракта и передеплой. **Боту работать в WBNB**, BNB держать только на газ.

Выход в BNB (`USDT → BNB`) работает: своп в WBNB, затем `unwrapWBNB`.

---

## 5. Комиссии: вестинг меняет экономику

Комиссия не приходит сразу. Она лежит в `pending` и становится доступной через
`jitDelayBlocks` блоков:

| fee | ставка | блоков | ≈ |
|---|---|---|---|
| 50 | 0.005% | 250 | 1.9 мин |
| **500** | **0.05%** | **1150** | **8.6 мин** |
| 2500 | 0.25% | 5150 | 39 мин |
| 10000 | 1% | 20150 | 2.5 часа |

Наш пул — тир 500, значит **1150 блоков** (~8.8 мин по замеру: блок 0.46 с).

### Ловушка: эти настройки живут в ФАБРИКЕ, не в пуле

`jitDelayBlocks(fee)` и `reversalPenaltyK(fee)` — это **public mapping в
контракте фабрики**. У пула таких функций нет: он читает их через вызов
фабрики (`_jitDelay()` в `SementsulV3.sol`). Обращение к пулу по этим именам
ревертит с `execution reverted`, без внятной причины.

```js
// неправильно — упадёт
await pool.read.jitDelayBlocks([500])

// правильно
await factory.read.jitDelayBlocks([500])       // → 1150n
await factory.read.reversalPenaltyK([500])     // → 0n
```

Проверено на цепи: оба значения читаются из фабрики
`0xc0b597bee57bba0aae2ce9e73e83217331a24dd9`.

### Как это выглядит в данных

Комиссия начисляется **лениво**. Пока позицию не тронули, поля нулевые, хотя
`feeGrowthGlobal0X128` уже вырос:

```
positions(key):
  tokensOwed0 = 0     ← ещё не перенесено
  pending0    = 0     ← вестинг не начат
  vestBlock   = 0     ← срок не выставлен
```

**Первый `collect` вернёт 0.** Он только перенесёт начисленное в `pending` и
выставит `vestBlock = block + 1150`. Забрать — вторым вызовом после этого блока.

Бот, который после свопа сразу зовёт `collect` и ждёт денег, получит ноль и
решит, что сломалось. Сейчас в `snapshot()` он читает `collect` через
`simulateContract` и берёт `tokensOwed` — это будет 0 всегда, пока не истечёт
вестинг.

### Сгорание при снятии

Снятие ликвидности **до** истечения вестинга сжигает `pending` пропорционально
снятой доле. Снял 100% — потерял всё незрелое.

Это и есть защита от JIT. Для честного LP — издержка: снимая позицию, надо
дождаться конца вестинга, иначе комиссия пропадёт.

### Что это значит для лестницы

`LADDER_COUNT=25`, `LADDER_STEP=5` — бот переставляет позиции по уровням цены.
Каждая перестановка = `burn` + `mint`. Если чаще 1150 блоков, комиссия сгорает
каждый раз.

Варианты:

- **увеличить шаг**: реже переставлять, дольше держать;
- **снимать частично**: `burn` части оставляет пропорциональную часть `pending`
  (контракт считает `pending * keep / gross`);
- **сначала `collect`, ждать, потом `burn`** — но это замедляет реакцию;
- **смириться**: на узких диапазонах комиссия и так невелика.

Решать надо осознанно, а не «как получится».

---

## 6. Чего НЕ надо менять

- **Порядок токенов** — совпадает (USDT = token0).
- **Формулы `ticksForLevel` / `tickFromPrice` / `alignTick`** — уже верные,
  проверено выше.
- **`liquidityForBudget` / `amountsFor`** — математика Uniswap, подходит без
  изменений.
- **Потолок газа 16 777 216** — ограничение приватного RPC
  (`bscrpc.pancakeswap.finance`). Оставить.
- **`SEND_RPC_URL`** — приватный RPC нужен, иначе фронтраннинг.

---

## 7. Порядок работы

1. **Сначала чтение.** Поменять ABI пула на `artifacts.json`, переписать
   `slot0` на 5 полей, проверить, что `snapshot()` отдаёт разумные числа.
   Ничего не отправлять.
2. **Потом свопы.** Перевести `swapV3` на ABI нашего роутера. Проверить
   `eth_call` с подменой состояния, не отправляя транзакцию.
3. **Потом позиции.** Переписать `mint`/`burn`/`collect` на прямые вызовы
   пула, переписать индексы в `buildPosition`.
4. **Потом схему D1.** `token_id` → ключ позиции.
5. **В последнюю очередь** — вестинг и шаг лестницы.

Каждый шаг проверяем на маленькой сумме до перехода к следующему.

---

## 8. Как проверить, что получилось

Дымовые тесты, которые уже есть в репозитории:

```bash
cd sementsul-dex

# Все ветки обмена через наш роутер: обычный, обратный, выход в BNB
node scripts/test-all-v3-swaps.mjs
#   ok   WBNB -> USDT обычный -> ~55.6 USDT за 0.1 WBNB
#   ok   USDT -> WBNB обратный
#   ok   USDT -> BNB нативный выход
#   ok   BNB -> USDT: честно отказывает

# Состояние позиции и вестинга
node scripts/check-fees.mjs

# Селекторы против байткода роутера
node scripts/check-router-selectors.mjs

# Сверка сборки calldata с эталоном viem
node scripts/compare-calldata.mjs

# Все факты этого документа
node scripts/verify-bot-doc.mjs
```

Последний скрипт сверяет с цепью: порядок токенов, число полей `slot0`,
границы цены для тиков, задержки вестинга, селекторы, `reversalPenaltyK`,
разницу между `encodePacked` и `encode`. Если что-то в этом документе устареет
— он покажет.

`eth_call` с подменой состояния — основной инструмент. Он не тратит газ и
показывает точную причину отката. Образец: `scripts/test-all-v3-swaps.mjs`
(подмена `balanceOf` и `allowance` через `stateOverride`).

Ловушка при подмене: **слоты `balanceOf` у токенов разные**. У WBNB это слот
3, у USDT — 1. Если подставить не туда, `eth_call` покажет нехватку средств,
и это будет выглядеть как ошибка контракта.

---

## 9. Ссылки

- Пул: https://bscscan.com/address/0x37c7702B589c69D1e4f4ad32E19f372ED6780278
- Фабрика: https://bscscan.com/address/0xc0b597bee57bba0aae2ce9e73e83217331a24dd9
- Роутер: https://bscscan.com/address/0xf98b7f4effb34dae1f785010ecf71ff796e7fdd1
- Исходники: `sementsul-dex/contracts/SementsulV3.sol`, `SementsulV3Router.sol`
- Исходники на GitHub: https://github.com/sementsul/sementsul-dex
- ABI: `sementsul-dex/src/contracts/artifacts.json`
- Адреса: `sementsul-dex/src/contracts/deployments.js`

Контракты проверены на BscScan: опубликованный исходник совпадает с
исполняемым. Компилятор `v0.8.24`, оптимизатор 200.

---

## 10. Вывод средств и два молчаливых бага в `withdraw.mjs`

Капитал под новый пул переведён на кошелёк бота скриптом
`scripts/withdraw.mjs`. По дороге в нём нашлись два дефекта. Оба глушили
ошибку и оба касались денег — прочитать, если сессия будет трогать финансы.

### Баг 1: `balanceOf` ждал объект, а получал строку

```js
// было
async function balanceOf(token, owner) {
  return read.readContract({ address: token.address, ... })  // token — строка!
}
...
await balanceOf(t.address, from.address)   // передаётся строка
```

У строки нет поля `address`, поэтому в `readContract` уходил `undefined`.
Вызов падал с `Transaction creation failed`, а `catch` возвращал `0n` молча.

**Симптом:** `node scripts/withdraw.mjs --list` показывал только BNB, будто
токенов на кошельке нет. На самом деле там лежало 134 USDT. Отличить «пусто»
от «не прочиталось» было невозможно.

**Исправлено:** `resolveTokenAddress()` принимает и строку, и объект, проверяет
формат регуляркой и бросает понятную ошибку. Причина сбоя чтения печатается
в stderr, но не останавливает вывод остальных токенов.

### Баг 2: без `--all` уходили ВСЕ токены

```js
// было
const targets = only ? found.filter(...) : allTokens ? found : found
//                                          одинаково ^^^^^^^^^^^^^^
```

Обе ветки тернарника возвращали одно и то же, поэтому вызов без `--all`
отправлял всё найденное. На практике `--token WBNB` дополнительно увёл
**899 999 999.9 SEM** на 0x9225…: скрипт видел SEM в общем списке и не
спрашивал, нужен ли он.

**Исправлено:** умолчание — «не отправлять ничего». Явный `--token SYM` или
`--all` обязателен. Логика вынесена в `scripts/lib/withdraw-targets.mjs` и
покрыта 15 тестами (`scripts/test-withdraw.mjs`, входит в `npm test`).

### Что ушло на кошелёк бота

| Токен | Сумма | Откуда |
|---|---|---|
| USDT | 134.536 | receiver `0x22eA…` |
| WBNB | 0.001854 | receiver + deployer |
| BNB | 0.012898 | receiver + deployer, за вычетом газа |
| SEM | 899 999 999.9 | **случайно**, баг 2. Бесполезен, вернуть нельзя |

SEM — тестовый токен, снятый с биржи. На торговлю не влияет, но если сессия
увидит его в балансах и решит, что это капитал — это ошибка.

### Как выводить правильно

```bash
node scripts/withdraw.mjs --list                      # только показать
node scripts/withdraw.mjs --to 0x… --dry-run          # проверить план
node scripts/withdraw.mjs --to 0x… --token USDT       # один токен
node scripts/withdraw.mjs --to 0x… --all              # все токены
node scripts/withdraw.mjs --to 0x… --all --all-keep-gas   # + BNB, оставив газ
```

Всегда сначала `--dry-run`: он печатает точный план и ничего не отправляет.
Транзакции идут через приватный RPC Pancake (`bscrpc.pancakeswap.finance`),
минуя публичный мемпул.
-- Схема D1 для индексатора сделок.
-- Применение: wrangler d1 execute sementsul-dex --file=worker/schema.sql --remote

CREATE TABLE IF NOT EXISTS trades (
  tx_hash     TEXT    NOT NULL,
  log_index   INTEGER NOT NULL,
  block       INTEGER NOT NULL,
  ts          INTEGER NOT NULL,       -- unix-время блока, секунды
  pair        TEXT    NOT NULL,
  protocol    TEXT    NOT NULL,       -- 'v2' | 'v3'
  kind        TEXT    NOT NULL DEFAULT 'swap', -- 'swap' | 'flash'
  zero_for_one INTEGER NOT NULL,      -- 1 = продажа token0 за token1
  amount_in   TEXT    NOT NULL,       -- строкой: uint256 не влезает в INTEGER
  amount_out  TEXT    NOT NULL,
  price       TEXT    NOT NULL,       -- token1 за token0, масштаб 1e18; 0 у flash
  PRIMARY KEY (tx_hash, log_index)
);

-- Основной запрос: свечи и последние сделки по паре во времени.
-- kind в индексе, потому что все запросы фильтруют по нему.
CREATE INDEX IF NOT EXISTS idx_trades_pair_ts ON trades (pair, kind, ts DESC);
CREATE INDEX IF NOT EXISTS idx_trades_block ON trades (block);

-- Индекс под сортировку «последние сделки» и «последняя цена».
--
-- idx_trades_pair_ts сортирует по ts, а /api/trades и /api/stats берут
-- ORDER BY block DESC, log_index DESC. Из-за несовпадения порядка SQLite
-- строил USE TEMP B-TREE FOR ORDER BY — то есть сортировал ВСЮ выборку пары
-- в памяти на каждый запрос, вместо того чтобы прочитать первые N строк по
-- индексу. На бесплатном тарифе это и есть та самая «read amplification».
CREATE INDEX IF NOT EXISTS idx_trades_pair_block
  ON trades (pair, kind, block DESC, log_index DESC);

-- Метаданные индексатора: последний обработанный блок на пару.
CREATE TABLE IF NOT EXISTS sync_state (
  pair        TEXT PRIMARY KEY,
  last_block  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- ВАЖНО про регистр pair.
--
-- Индексатор (scripts/index.mjs) пишет адрес в EIP-55-виде, а фронтенд берёт
-- его из src/contracts/deployments.js, где контрольная сумма может быть
-- расставлена иначе. SQLite сравнивает TEXT побайтово, поэтому `pair = ?`
-- не находил строк, и API отдавал 200 с пустым массивом при живых данных.
--
-- Договорённость: pair хранится и сравнивается ТОЛЬКО в нижнем регистре.
-- Воркер нормализует вход через normPair(), индексатор обязан делать то же.
-- Миграция существующих строк — worker/migrate-lowercase-pair.sql.
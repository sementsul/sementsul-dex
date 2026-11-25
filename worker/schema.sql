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

-- Метаданные индексатора: последний обработанный блок на пару.
CREATE TABLE IF NOT EXISTS sync_state (
  pair        TEXT PRIMARY KEY,
  last_block  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
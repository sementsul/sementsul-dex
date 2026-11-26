-- Приведение pair к нижнему регистру во всех таблицах.
--
-- Зачем: индекс пишет адрес в EIP-55-виде, а фронтенд берёт его из
-- deployments.js, где контрольная сумма расставлена иначе (…D1e4… против
-- …D1E4…). SQLite сравнивает TEXT побайтово, поэтому `pair = ?` не находил
-- ни одной строки, и API отдавал 200 с пустым массивом при живых данных.
--
-- После нормализации индекс idx_trades_pair_ts снова работает: запрос
-- идёт по точному совпадению, а не через LOWER(), который снимает индекс.

UPDATE trades SET pair = LOWER(pair) WHERE pair <> LOWER(pair);
UPDATE sync_state SET pair = LOWER(pair) WHERE pair <> LOWER(pair);

SELECT 'trades' AS tbl, COUNT(*) AS rows, SUM(pair = LOWER(pair)) AS lower_ok FROM trades
UNION ALL
SELECT 'sync_state', COUNT(*), SUM(pair = LOWER(pair)) FROM sync_state;
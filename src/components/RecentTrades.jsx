// Блок «Последние сделки» под карточкой обмена.
//
// Данные берутся из воркера-индексатора. Если он недоступен, блок просто не
// рендерится: история — приятное дополнение, а не условие работы обмена.

import { useEffect, useState } from 'react'
import { fetchRecentTrades, isIndexerAvailable } from '../lib/indexer.js'
import { TRADES_PAIR, TRADES_PAIR_LABEL } from '../lib/chain.js'
import { formatAmount, formatPrice } from '../lib/format.js'

function timeAgo(unixSec) {
  const diff = Math.floor(Date.now() / 1000) - unixSec
  if (diff < 60) return 'только что'
  if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`
  if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`
  return `${Math.floor(diff / 86400)} дн назад`
}

export default function RecentTrades() {
  const [state, setState] = useState({ status: 'loading', trades: [], error: null })

  useEffect(() => {
    let alive = true

    const load = async () => {
      const ok = await isIndexerAvailable()
      if (!alive) return
      if (!ok) {
        setState({ status: 'unavailable', trades: [], error: null })
        return
      }
      try {
        const trades = await fetchRecentTrades(TRADES_PAIR, 6)
        if (!alive) return
        setState({ status: 'ready', trades, error: null })
      } catch (e) {
        if (!alive) return
        setState({ status: 'unavailable', trades: [], error: e?.message })
      }
    }

    load()
    // Обновляем раз в минуту — новые сделки в этом пуле редки.
    const timer = setInterval(load, 60_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  // Воркера нет — не занимаем место на экране.
  if (state.status === 'unavailable') return null

  return (
    <div className="card trades-card">
      <div className="trades-head">
        <h2>Последние сделки</h2>
        <span className="trades-pair">{TRADES_PAIR_LABEL}</span>
      </div>

      {state.status === 'loading' && (
        <div className="trades-empty">Загружаем историю…</div>
      )}

      {state.status === 'ready' && state.trades.length === 0 && (
        <div className="trades-empty">
          Сделок пока нет. Пул существует, но по нему давно не торговали.
        </div>
      )}

      {state.status === 'ready' && state.trades.length > 0 && (
        <div className="trades-list">
          {state.trades.map((t) => {
            // Цена приходит как WBNB за второй токен пары; показываем в удобном виде.
            const priceInBnb = t.zeroForOne ? t.price : t.price > 0 ? 1 / t.price : 0
            return (
              <a
                key={`${t.txHash}-${t.block}`}
                className="trade-row"
                href={`https://bscscan.com/tx/${t.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                <span className={`trade-dir ${t.zeroForOne ? 'sell' : 'buy'}`}>
                  {t.zeroForOne ? 'Продажа' : 'Покупка'}
                </span>
                <span className="trade-price mono">{formatPrice(priceInBnb)} BNB</span>
                <span className="trade-time">{timeAgo(t.ts)}</span>
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}
// Блок «Последние сделки» под карточкой обмена.
//
// Показываем только сделки нашего пула. Если пула нет, индексатор недоступен
// или сделок не было — блок не рендерится вовсе. Это осознанно: раньше здесь
// вперемешку шли чужие сделки Pancake с ценой, подписанной «BNB», хотя это
// USDT за WBNB. Лучше не показать ничего, чем показать не то.

import { useEffect, useState } from 'react'
import { fetchRecentTrades, isIndexerAvailable } from '../lib/indexer.js'
import { TRADES_POOL, TRADES_PAIR_LABEL } from '../lib/chain.js'
import { formatPrice } from '../lib/format.js'
import { useI18n } from '../lib/useI18n.jsx'

// Относительное время. t передаём снаружи: функция вызывается из рендера, а
// не является компонентом, поэтому хук внутри неё взять нельзя.
function timeAgo(unixSec, t) {
  const diff = Math.floor(Date.now() / 1000) - unixSec
  if (diff < 60) return t('trades.justNow')
  if (diff < 3600) return t('trades.minAgo', { n: Math.floor(diff / 60) })
  if (diff < 86400) return t('trades.hourAgo', { n: Math.floor(diff / 3600) })
  return t('trades.dayAgo', { n: Math.floor(diff / 86400) })
}

export default function RecentTrades() {
  const { t } = useI18n()
  const [state, setState] = useState({ status: 'loading', trades: [], error: null })

  useEffect(() => {
    // Своего пула нет — показывать нечего и незачем.
    if (!TRADES_POOL) {
      setState({ status: 'unavailable', trades: [], error: null })
      return
    }

    let alive = true

    const load = async () => {
      const ok = await isIndexerAvailable()
      if (!alive) return
      if (!ok) {
        setState({ status: 'unavailable', trades: [], error: null })
        return
      }
      try {
        const trades = await fetchRecentTrades(TRADES_POOL, 6)
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

  // Нет воркера или нет пула — не занимаем место на экране.
  if (state.status === 'unavailable') return null

  // Пустой список — тоже не показываем: «сделок пока нет» на главной выглядит
  // как поломка, а не как честная информация.
  if (state.status === 'ready' && state.trades.length === 0) return null

  return (
    <div className="card trades-card">
      <div className="trades-head">
        <h2>{t('trades.title')}</h2>
        <span className="trades-pair">{TRADES_PAIR_LABEL}</span>
      </div>

      {state.status === 'loading' && (
        <div className="trades-empty">{t('trades.loading')}</div>
      )}

      {state.status === 'ready' && (
        <div className="trades-list">
          {state.trades.map((tr) => {
            // В базе цена лежит как token1 за token0, то есть WBNB за 1 USDT
            // (около 0.0018). На экране нужна привычная цена — USDT за 1 WBNB,
            // поэтому переворачиваем её один раз здесь.
            //
            // Раньше переворот зависел от направления сделки, хотя цена в базе
            // уже нормализована по направлению. Из-за этого половина строк
            // показывала 0.0018, а половина — 540, и подпись «BNB» не имела
            // отношения ни к одной из них.
            const usdtPerBnb = tr.price > 0 ? 1 / tr.price : 0

            // zeroForOne = вход в token0, то есть USDT -> WBNB: покупают WBNB.
            const buying = tr.zeroForOne

            return (
              <a
                key={`${tr.txHash}-${tr.block}`}
                className="trade-row"
                href={`https://bscscan.com/tx/${tr.txHash}`}
                target="_blank"
                rel="noreferrer"
              >
                <span className={`trade-dir ${buying ? 'buy' : 'sell'}`}>
                  {buying ? t('trades.buy') : t('trades.sell')}
                </span>
                <span className="trade-price mono">
                  {formatPrice(usdtPerBnb)} USDT
                </span>
                <span className="trade-time">{timeAgo(tr.ts, t)}</span>
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}
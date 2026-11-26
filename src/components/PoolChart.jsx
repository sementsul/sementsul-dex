// График пула. Встраиваем страницу DexScreener через iframe.
//
// Почему чужой iframe, а не свой график:
//
// 1. У нас есть собственные OHLCV-свечи (/api/candles из воркера), но в базе
//    несколько десятков сделок. График из семи точек — это не график, а
//    издевательство: по нему нельзя судить ни о тренде, ни о волатильности.
//    DexScreener видит те же сделки, но у него есть история дольше нашей.
//
// 2. Своего TradingView-подобного рендера у нас нет, а тащить библиотеку
//    графиков ради одной страницы — это сотни килобайт в бандле.
//
// Ограничения, о которых честно сказано в интерфейсе:
// - это данные третьей стороны, не наши;
// - их доступность не в нашей власти: если DexScreener ляжет, график исчезнет,
//   а обмен продолжит работать. Поэтому график не обязателен для работы пула;
// - для нового пула, который DexScreener ещё не проиндексировал, графика не
//   будет вообще. Это не ошибка, а отсутствие данных, и интерфейс должен
//   говорить именно так, а не показывать пустую рамку.
//
// Iframe грузится только после нажатия: незачем тянуть чужую страницу с
// чужими скриптами тому, кто пришёл просто добавить ликвидность.

import { useCallback, useState } from 'react'
import { useI18n } from '../lib/useI18n.jsx'
import { Spinner } from './ui.jsx'

const DEXSCREENER_API = 'https://api.dexscreener.com/latest/dex/pairs/bsc'

// Собираем адрес встраиваемой страницы.
// embed=1 — режим без шапки сайта, ровно то, что нужно для iframe.
// theme=dark — под наш тёмный интерфейс.
// trades=0 — список сделок убираем: у нас на странице уже есть свой.
function embedUrl(pair) {
  return `https://dexscreener.com/bsc/${pair}?embed=1&theme=dark&trades=0&info=0`
}

function pageUrl(pair) {
  return `https://dexscreener.com/bsc/${pair}`
}

export default function PoolChart({ pair, symbol0, symbol1 }) {
  const { t } = useI18n()
  // idle -> checking -> ready | missing | failed
  const [state, setState] = useState('idle')

  const open = useCallback(async () => {
    setState('checking')
    try {
      const res = await fetch(`${DEXSCREENER_API}/${pair}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const found = Array.isArray(data?.pairs) && data.pairs.length > 0
      setState(found ? 'ready' : 'missing')
    } catch {
      // Проверка не удалась — это не повод не показывать график. Сеть могла
      // отвалиться или DexScreener прикрыл API, а страница при этом жива.
      // Показываем iframe и не делаем вид, что знаем больше, чем знаем.
      setState('ready')
    }
  }, [pair])

  if (state === 'idle') {
    return (
      <div className="pool-chart-collapsed">
        <button className="ghost-btn" onClick={open}>
          {t('chart.show')}
        </button>
        <span className="dim small">{t('chart.thirdPartyHint')}</span>
      </div>
    )
  }

  if (state === 'checking') {
    return (
      <div className="pool-chart-collapsed">
        <Spinner /> <span className="dim small">{t('chart.checking')}</span>
      </div>
    )
  }

  if (state === 'missing') {
    return (
      <div className="pool-chart-missing">
        <p>{t('chart.notIndexed', { a: symbol0, b: symbol1 })}</p>
        <p className="dim small">{t('chart.notIndexedWhy')}</p>
        <a className="ghost-btn" href={pageUrl(pair)} target="_blank" rel="noopener noreferrer">
          {t('chart.openExternal')}
        </a>
      </div>
    )
  }

  return (
    <div className="pool-chart">
      <div className="pool-chart-frame">
        <iframe
          // React сам подставит title в aria; без него iframe нечитаем для
          // скринридеров, а это единственный ориентир внутри чужой страницы.
          title={t('chart.frameTitle', { a: symbol0, b: symbol1 })}
          src={embedUrl(pair)}
          loading="lazy"
          // allowfullscreen нужен, потому что TradingView внутри разрешает
          // развернуть график.
          allowFullScreen
        />
      </div>
      <p className="pool-chart-note">
        {t('chart.note')}{' '}
        <a href={pageUrl(pair)} target="_blank" rel="noopener noreferrer">
          {t('chart.openExternal')}
        </a>
      </p>
    </div>
  )
}
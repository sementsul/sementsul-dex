import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadPools, isEmptyPool, clearPriceCache } from '../lib/liquidity.js'
import { HAS_OWN_DEX } from '../lib/chain.js'
import { formatUsd, formatAmount } from '../lib/format.js'
import { TokenIcon, Spinner, Notice, CopyAddress } from './ui.jsx'
import { useI18n } from '../lib/useI18n.jsx'
import CreatePool from './CreatePool.jsx'
import { LiquidityPanel } from './LiquidityPanel.jsx'

// Список пулов: то, что заменяет «главную страницу» биржи.
//
// Показываем TVL, объём резервов и комиссию. TVL может быть неизвестен (нет
// пути к USDT) — тогда честный прочерк, а не ноль: ноль читался бы как
// «пул пустой» и отпугнул бы от него.
export default function PoolsPage({ wallet }) {
  const { t } = useI18n()
  const [pools, setPools] = useState(null)
  const [error, setError] = useState(null)
  const [query, setQuery] = useState('')
  const [showEmpty, setShowEmpty] = useState(true)
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState(null)
  const [reloadKey, setReloadKey] = useState(0)

  const load = useCallback(async () => {
    setPools(null)
    setError(null)
    // Кеш цен сбрасываем: после добавления ликвидности цена могла измениться,
    // и старое значение TVL выглядело бы как «ничего не произошло».
    clearPriceCache()
    try {
      const list = await loadPools()
      setPools(list)
    } catch (e) {
      setError(e?.message || String(e))
      setPools([])
    }
  }, [])

  useEffect(() => {
    load()
  }, [load, reloadKey])

  const filtered = useMemo(() => {
    if (!pools) return null
    const q = query.trim().toLowerCase()
    return pools.filter((p) => {
      if (!showEmpty && isEmptyPool(p)) return false
      if (!q) return true
      const hay = [
        p.token0.symbol,
        p.token1.symbol,
        p.token0.name,
        p.token1.name,
        p.address,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [pools, query, showEmpty])

  if (selected) {
    return (
      <LiquidityPanel
        pool={selected}
        wallet={wallet}
        onBack={() => setSelected(null)}
        onDone={() => {
          setSelected(null)
          setReloadKey((k) => k + 1)
        }}
      />
    )
  }

  if (creating) {
    return (
      <CreatePool
        wallet={wallet}
        onBack={() => setCreating(false)}
        onCreated={() => {
          setCreating(false)
          setReloadKey((k) => k + 1)
        }}
      />
    )
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('pools.title')}</h1>
          <p className="page-sub">{t('pools.sub')}</p>
        </div>
        <button className="primary-btn compact" onClick={() => setCreating(true)}>
          {t('pools.create')}
        </button>
      </div>

      <div className="pool-toolbar">
        <input
          className="search-input"
          placeholder={t('pools.searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="check-inline">
          <input type="checkbox" checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)} />
          <span>{t('pools.showEmpty')}</span>
        </label>
        <button className="ghost-btn" onClick={() => setReloadKey((k) => k + 1)} title={t('pools.refresh')}>
          {t('pools.refresh')}
        </button>
      </div>

      {error && <Notice kind="error">{t('pools.loadFailed', { error })}</Notice>}

      {!HAS_OWN_DEX && <Notice kind="warn">{t('pools.notDeployed')}</Notice>}

      {pools === null ? (
        <div className="pool-loading">
          <Spinner /> {t('pools.loading')}
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <p>{query ? t('pools.nothingFound') : t('pools.noneYet')}</p>
          <button className="ghost-btn" onClick={() => setCreating(true)}>
            {t('pools.createFirst')}
          </button>
        </div>
      ) : (
        <div className="pool-table">
          <div className="pool-table-head">
            <span>{t('pools.colPool')}</span>
            <span className="right">{t('pools.colTvl')}</span>
            <span className="right">{t('pools.colReserves')}</span>
            <span className="right">{t('pools.colFee')}</span>
            <span />
          </div>
          {filtered.map((p) => (
            <PoolRow key={p.address} pool={p} onSelect={() => setSelected(p)} />
          ))}
        </div>
      )}

      <div className="page-note">
        <strong>{t('pools.tvlNoteTitle')}</strong> {t('pools.tvlNote')}
      </div>
    </div>
  )
}

function PoolRow({ pool, onSelect }) {
  const { t } = useI18n()
  const isV3 = pool.protocol === 'v3'

  // Комиссия приходит в единицах 1e-6: 2500 -> 0.25%, 50 -> 0.005%.
  // У чужих V2-пар метода fee() нет, поэтому возможен прочерк.
  const feePct = pool.fee === null || pool.fee === undefined ? null : pool.fee / 10000

  const reserves = isV3
    ? `${formatAmount(pool.balance0, pool.token0.decimals, 4)} / ${formatAmount(pool.balance1, pool.token1.decimals, 4)}`
    : `${formatAmount(pool.reserve0, pool.token0.decimals, 4)} / ${formatAmount(pool.reserve1, pool.token1.decimals, 4)}`

  const empty = isEmptyPool(pool)

  return (
    // Раньше здесь был <button>. Кнопку копирования внутрь неё вложить нельзя:
    // браузер не разрешает button внутри button, а клик по вложенной всплывал
    // бы и переключал пул вместо копирования. Поэтому строка — div с
    // role="button": поведение то же, а внутри можно разместить копирование.
    <div
      className="pool-row"
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <span className="pool-pair">
        <span className="pool-icons">
          <TokenIcon token={pool.token0} size={22} />
          <TokenIcon token={pool.token1} size={22} />
        </span>
        <span className="pool-pair-text">
          <span className="pool-name">
            {pool.token0.symbol} / {pool.token1.symbol}
          </span>
          <span className="pool-meta">
            <span className={isV3 ? 'badge v3' : 'badge'}>{isV3 ? 'V3' : 'V2'}</span>
            {empty && <span className="badge empty">{t('pools.emptyBadge')}</span>}
            <CopyAddress address={pool.address} chars={4} className="in-row" />
          </span>
        </span>
      </span>
      <span className="right mono">{pool.tvl === null ? '—' : formatUsd(pool.tvl)}</span>
      <span className="right mono dim">{reserves}</span>
      <span className="right mono">{feePct === null ? '—' : `${feePct}%`}</span>
      <span className="pool-chevron">›</span>
    </div>
  )
}
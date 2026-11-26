// Переиспользуемые UI-примитивы.

import { useEffect, useState } from 'react'
import { useI18n } from '../lib/useI18n.jsx'

// Иконка токена с откатом на первую букву, если логотип не загрузился.
// Раньше здесь были первые три буквы символа — рядом с самим символом это
// читалось как «BUSBUSD».
export function TokenIcon({ token, size = 22 }) {
  const [broken, setBroken] = useState(false)
  const label = (token?.symbol ?? '?').slice(0, 1).toUpperCase()

  if (!token?.logo || broken) {
    return (
      <span className="token-fallback" style={{ width: size, height: size, fontSize: size * 0.5 }}>
        {label}
      </span>
    )
  }
  return (
    <img
      src={token.logo}
      alt={token.symbol}
      width={size}
      height={size}
      onError={() => setBroken(true)}
      loading="lazy"
    />
  )
}

// Модалка выбора токена.
export function TokenPicker({ tokens, exclude, onSelect, onClose, balances, onAddToken }) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const q = query.trim().toLowerCase()
  const list = tokens.filter((t) => {
    if (exclude && t.address.toLowerCase() === exclude.toLowerCase()) return false
    if (!q) return true
    return (
      t.symbol.toLowerCase().includes(q) ||
      t.name.toLowerCase().includes(q) ||
      t.address.toLowerCase() === q
    )
  })

  // Ввод произвольного адреса: если это валидный 0x-адрес и его нет в списке,
  // предлагаем загрузить метаданные из сети и добавить в селектор.
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(query.trim())
  const alreadyKnown = tokens.some((t) => t.address.toLowerCase() === q)
  const canImport = isAddress && !alreadyKnown && typeof onAddToken === 'function'

  const handleImport = async () => {
    setLoading(true)
    setError(null)
    try {
      const token = await onAddToken(query.trim())
      if (token) onSelect(token)
    } catch (e) {
      setError(e?.message ?? t('token.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t('token.choose')}</span>
          <button className="close-btn" onClick={onClose} aria-label={t('token.close')}>
            ×
          </button>
        </div>
        <div className="modal-search">
          <input
            autoFocus
            placeholder={t('token.searchPlaceholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="token-list">
          {canImport && (
            <button
              className="token-item import-item"
              onClick={handleImport}
              disabled={loading}
              style={{ borderBottom: '1px solid var(--border-soft)', borderRadius: 0 }}
            >
              <span
                className="token-fallback"
                style={{ width: 30, height: 30, fontSize: 12 }}
              >
                {loading ? '…' : '+'}
              </span>
              <div className="token-item-info">
                <div className="token-item-symbol">
                  {loading ? t('token.importing') : t('token.import')}
                </div>
                <div className="token-item-name mono">{query.trim()}</div>
              </div>
            </button>
          )}

          {error && (
            <div style={{ padding: '10px 12px', color: 'var(--red)', fontSize: 13 }}>{error}</div>
          )}

          {list.length === 0 && !canImport && (
            <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}>
              {q.length === 42 ? t('token.notInList') : t('token.notFound')}
            </div>
          )}
          {list.map((titem) => {
            const bal = balances?.[titem.address.toLowerCase()]
            return (
              <button key={titem.address} className="token-item" onClick={() => onSelect(titem)}>
                <TokenIcon token={titem} size={30} />
                <div className="token-item-info">
                  <div className="token-item-symbol">
                    {titem.symbol}
                    {titem.verified && (
                      <span className="verified-mark" title={t('token.verified')}>✓</span>
                    )}
                    {titem.imported && (
                      <span style={{ fontSize: 10, color: 'var(--text-faint)', fontWeight: 500 }}>
                        {t('token.imported')}
                      </span>
                    )}
                  </div>
                  <div className="token-item-name">{titem.name}</div>
                </div>
                {bal !== undefined && bal !== null && (
                  <span className="mono" style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                    {bal}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// Бейджи протокола маршрута: V2 / V3 0.01% / V3 0.25% …
export function RouteBadges({ hops }) {
  return (
    <div className="route-badges">
      {hops.map((h, i) => (
        <span key={i} className={h.protocol === 'v3' ? 'badge v3' : 'badge'}>
          {h.protocol === 'v2' ? 'V2' : `V3 ${(h.fee / 10000).toFixed(2)}%`}
        </span>
      ))}
    </div>
  )
}

// Полоска price impact.
export function ImpactBar({ bps }) {
  const pct = Math.min(100, Math.max(0, (bps / 500) * 100))
  const color = bps >= 300 ? 'var(--red)' : bps >= 100 ? 'var(--amber)' : 'var(--green)'
  return (
    <div className="impact-bar">
      <div className="impact-fill" style={{ width: `${Math.max(2, pct)}%`, background: color }} />
    </div>
  )
}

export function Spinner({ light }) {
  return <span className={light ? 'spinner light' : 'spinner'} />
}

// Уведомление.
export function Notice({ kind = 'info', children }) {
  return <div className={`notice ${kind}`}>{children}</div>
}

// Копирование адреса контракта в буфер обмена.
//
// Раньше адрес показывался сокращённым (0x1234...abcd) и скопировать его было
// нельзя вообще: строка пула — это <button>, и вложенная кнопка «копировать»
// внутри неё не работает (браузер не даёт вкладывать button в button, а клик
// внутри всплывает и переключает пул). Поэтому копирование вынесено отдельным
// элементом рядом с адресом, а полный адрес показывается в подсказке.
//
// navigator.clipboard доступен только в защищённом контексте (https или
// localhost). На http он есть в объекте, но writeText отклоняется — поэтому
// предусмотрен запасной путь через скрытое поле и execCommand.
export function CopyAddress({ address, chars = 4, label, className = '' }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!copied) return undefined
    // Возвращаем подпись обратно: иначе «скопировано» висит вечно и перестаёт
    // что-либо сообщать.
    const t = setTimeout(() => setCopied(false), 1400)
    return () => clearTimeout(t)
  }, [copied])

  async function copy(e) {
    e.preventDefault()
    e.stopPropagation()

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(address)
      } else {
        throw new Error('clipboard api unavailable')
      }
    } catch {
      // Запасной путь: старый способ через выделение скрытого поля.
      try {
        const ta = document.createElement('textarea')
        ta.value = address
        // За пределами экрана, иначе страница дёрнется при фокусе.
        ta.style.position = 'fixed'
        ta.style.top = '-1000px'
        ta.setAttribute('readonly', '')
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        if (!ok) throw new Error('execCommand copy failed')
      } catch {
        setFailed(true)
        setTimeout(() => setFailed(false), 2000)
        return
      }
    }
    setCopied(true)
  }

  const short = `${address.slice(0, chars + 2)}...${address.slice(-chars)}`
  const text = copied ? t('copy.copied') : failed ? t('copy.failed') : label ?? short

  return (
    <button
      type="button"
      className={`copy-addr ${copied ? 'ok' : ''} ${failed ? 'bad' : ''} ${className}`}
      onClick={copy}
      title={copied ? t('copy.inBuffer') : t('copy.copyAddress', { address })}
      aria-label={t('copy.copyAddressAria', { address })}
    >
      <span className="mono">{text}</span>
      <span className="copy-icon" aria-hidden="true">
        {copied ? '✓' : failed ? '×' : '⧉'}
      </span>
    </button>
  )
}
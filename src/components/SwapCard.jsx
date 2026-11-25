// Основной экран свопа.
//
// Поток: пользователь вводит сумму -> дебаунс 350 мс -> котировка -> показ
// маршрута, комиссии и impact. Транзакция собирается локально, подписывается
// кошельком.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { quote, buildSwapTx, routeFeeBps, isNative } from '../lib/quote.js'
import { KNOWN_TOKENS, USDT, NATIVE, V2_ROUTER, V3_ROUTER, CHAIN_ID } from '../lib/chain.js'
import { readBalanceOf, readAllowance, readTokenMeta } from '../lib/pools.js'
import { formatAmount, parseAmount, formatBps } from '../lib/format.js'
import { sendTransaction, waitForReceipt, switchToBsc, getNativeBalance } from '../lib/wallet.js'
import { SEL, encAddress, encUint } from '../lib/abi.js'
import { TokenIcon, TokenPicker, RouteBadges, ImpactBar, Spinner, Notice } from './ui.jsx'

const SLIPPAGE_OPTIONS = [10, 50, 100] // 0.1%, 0.5%, 1%
const MAX_UINT256 = (1n << 256n) - 1n

export default function SwapCard({ wallet }) {
  const { account, chainId, available, connect, wrongChain } = wallet

  const [tokens, setTokens] = useState(() => {
    // Импортированные ранее токены переживают перезагрузку страницы.
    try {
      const saved = JSON.parse(localStorage.getItem('sml-dex:imported-tokens') ?? '[]')
      if (!Array.isArray(saved)) return KNOWN_TOKENS
      const known = new Set(KNOWN_TOKENS.map((t) => t.address.toLowerCase()))
      return [...KNOWN_TOKENS, ...saved.filter((t) => t?.address && !known.has(t.address.toLowerCase()))]
    } catch {
      return KNOWN_TOKENS
    }
  })
  const [tokenIn, setTokenIn] = useState(
    () => tokens.find((t) => t.address === NATIVE) ?? tokens[0]
  )
  const [tokenOut, setTokenOut] = useState(() => tokens.find((t) => t.address === USDT) ?? tokens[1])
  const [amountInStr, setAmountInStr] = useState('')
  const [pickerFor, setPickerFor] = useState(null)
  const [slippageBps, setSlippageBps] = useState(50)
  const [showSettings, setShowSettings] = useState(false)

  const [route, setRoute] = useState(null)
  const [quoting, setQuoting] = useState(false)
  const [quoteError, setQuoteError] = useState(null)

  const [balances, setBalances] = useState({})
  const [allowance, setAllowance] = useState(null)
  const [txState, setTxState] = useState({ status: 'idle', hash: null, error: null })

  const amountIn = useMemo(
    () => parseAmount(amountInStr, tokenIn?.decimals ?? 18),
    [amountInStr, tokenIn]
  )

  // ---------- балансы ----------

  const refreshBalances = useCallback(async () => {
    if (!account) return
    const out = {}
    for (const t of tokens) {
      try {
        const raw =
          t.address === NATIVE ? await getNativeBalance(account) : await readBalanceOf(t.address, account)
        out[t.address.toLowerCase()] = formatAmount(raw, t.decimals, 6)
      } catch {
        out[t.address.toLowerCase()] = '—'
      }
    }
    setBalances(out)
  }, [account, tokens])

  useEffect(() => {
    refreshBalances()
  }, [refreshBalances, txState.status])

  // Точный баланс токена на входе (для сравнения с суммой) — из сырого значения,
  // а не из округлённой строки.
  const [balanceInRaw, setBalanceInRaw] = useState(null)
  useEffect(() => {
    if (!account || !tokenIn) {
      setBalanceInRaw(null)
      return
    }
    let alive = true
    const load = async () => {
      try {
        const raw = isNative(tokenIn.address)
          ? await getNativeBalance(account)
          : await readBalanceOf(tokenIn.address, account)
        if (alive) setBalanceInRaw(raw)
      } catch {
        if (alive) setBalanceInRaw(null)
      }
    }
    load()
    return () => {
      alive = false
    }
  }, [account, tokenIn, txState.status])

  // ---------- котирование ----------

  const quoteSeq = useRef(0)

  useEffect(() => {
    if (!tokenIn || !tokenOut || amountIn <= 0n) {
      setRoute(null)
      setQuoteError(null)
      setQuoting(false)
      return
    }

    const seq = ++quoteSeq.current
    setQuoting(true)
    setQuoteError(null)

    const timer = setTimeout(async () => {
      try {
        const r = await quote(tokenIn.address, tokenOut.address, amountIn)
        if (seq !== quoteSeq.current) return
        if (!r) {
          setRoute(null)
          setQuoteError('Маршрут не найден: нет пула с достаточной ликвидностью')
        } else {
          setRoute(r)
        }
      } catch (e) {
        if (seq !== quoteSeq.current) return
        setRoute(null)
        setQuoteError(e?.message ?? 'Ошибка котирования')
      } finally {
        if (seq === quoteSeq.current) setQuoting(false)
      }
    }, 350)

    return () => clearTimeout(timer)
  }, [tokenIn, tokenOut, amountIn])

  // ---------- allowance ----------

  const spender = useMemo(() => {
    if (!route) return V2_ROUTER
    const allV2 = route.hops.every((h) => h.protocol === 'v2')
    return allV2 ? V2_ROUTER : V3_ROUTER
  }, [route])

  useEffect(() => {
    if (!account || !tokenIn || isNative(tokenIn.address)) {
      setAllowance(null)
      return
    }
    let alive = true
    readAllowance(tokenIn.address, account, spender)
      .then((a) => alive && setAllowance(a))
      .catch(() => alive && setAllowance(null))
    return () => {
      alive = false
    }
  }, [account, tokenIn, spender, txState.status])

  const needsApproval = useMemo(() => {
    if (!account || !tokenIn || isNative(tokenIn.address) || amountIn <= 0n) return false
    if (allowance === null) return false
    return allowance < amountIn
  }, [account, tokenIn, amountIn, allowance])

  // ---------- своп ----------

  const amountOut = route?.amountOut ?? 0n
  const minReceived = useMemo(
    () => (amountOut * BigInt(10000 - slippageBps)) / 10000n,
    [amountOut, slippageBps]
  )

  const insufficientBalance = balanceInRaw !== null && amountIn > balanceInRaw

  const handleApprove = useCallback(async () => {
    if (!tokenIn) return
    setTxState({ status: 'pending', hash: null, error: null })
    try {
      const data = SEL.approve + encAddress(spender) + encUint(MAX_UINT256)
      const hash = await sendTransaction({ to: tokenIn.address, data })
      setTxState({ status: 'pending', hash, error: null })
      await waitForReceipt(hash)
      setTxState({ status: 'success', hash, error: null })
      setAllowance(MAX_UINT256)
    } catch (e) {
      setTxState({ status: 'error', hash: null, error: friendlyError(e) })
    }
  }, [tokenIn, spender])

  const handleSwap = useCallback(async () => {
    if (!route || !account) return
    const tx = buildSwapTx({
      route,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      recipient: account,
      slippageBps,
    })
    if (!tx) {
      setTxState({
        status: 'error',
        hash: null,
        error: 'Этот маршрут требует Universal Router — пока не поддерживается',
      })
      return
    }

    setTxState({ status: 'pending', hash: null, error: null })
    try {
      const hash = await sendTransaction({ to: tx.to, data: tx.data, value: tx.value })
      setTxState({ status: 'pending', hash, error: null })
      const receipt = await waitForReceipt(hash)
      if (receipt.status === '0x0') {
        setTxState({ status: 'error', hash, error: 'Транзакция отменена сетью (revert)' })
      } else {
        setTxState({ status: 'success', hash, error: null })
        setAmountInStr('')
        setRoute(null)
      }
    } catch (e) {
      setTxState({ status: 'error', hash: null, error: friendlyError(e) })
    }
  }, [route, account, tokenIn, tokenOut, slippageBps])

  const handleSwitchTokens = useCallback(() => {
    setTokenIn(tokenOut)
    setTokenOut(tokenIn)
    setAmountInStr('')
    setRoute(null)
  }, [tokenIn, tokenOut])

  const handleMax = useCallback(() => {
    if (balanceInRaw === null) return
    // Для BNB оставляем 1% на газ.
    const v = isNative(tokenIn.address) ? (balanceInRaw * 99n) / 100n : balanceInRaw
    setAmountInStr(formatAmount(v, tokenIn.decimals, 18))
  }, [balanceInRaw, tokenIn])

  // Импорт произвольного токена по адресу: метаданные читаем из сети.
  const handleAddToken = useCallback(
    async (address) => {
      const meta = await readTokenMeta(address).catch((e) => {
        throw new Error(`Не удалось прочитать токен: ${e?.message ?? 'ошибка сети'}`)
      })
      if (!meta) throw new Error('По этому адресу нет ERC-20 токена')
      if (!meta.symbol || meta.symbol === '???') {
        throw new Error('Контракт не отдаёт symbol() — это не обычный ERC-20')
      }
      const token = {
        address,
        symbol: meta.symbol,
        name: meta.name,
        decimals: meta.decimals,
        imported: true,
      }
      setTokens((prev) => {
        if (prev.some((t) => t.address.toLowerCase() === address.toLowerCase())) return prev
        const next = [...prev, token]
        // Сохраняем только импортированные, чтобы не дублировать встроенный список.
        const imported = next.filter((t) => t.imported)
        try {
          localStorage.setItem('sml-dex:imported-tokens', JSON.stringify(imported))
        } catch {
          // приватный режим — просто не сохраняем
        }
        return next
      })
      return token
    },
    []
  )

  // ---------- кнопка ----------

  const buttonState = (() => {
    if (!available) {
      return {
        label: 'Установить MetaMask',
        disabled: false,
        href: 'https://metamask.io/download/',
      }
    }
    if (!account) return { label: 'Подключить кошелёк', disabled: false, onClick: connect }
    if (wrongChain) {
      return {
        label: 'Переключиться на BNB Chain',
        disabled: false,
        onClick: () => switchToBsc().catch(() => {}),
      }
    }
    if (amountIn <= 0n) return { label: 'Введите сумму', disabled: true }
    if (quoting) return { label: 'Считаем маршрут…', disabled: true, spinner: true }
    if (quoteError) return { label: 'Маршрут не найден', disabled: true }
    if (insufficientBalance) return { label: `Недостаточно ${tokenIn.symbol}`, disabled: true }
    if (needsApproval) {
      return { label: `Разрешить ${tokenIn.symbol}`, disabled: false, onClick: handleApprove, approve: true }
    }
    if (txState.status === 'pending') {
      return {
        label: txState.hash ? 'Подтверждаем…' : 'Ожидание в кошельке…',
        disabled: true,
        spinner: true,
      }
    }
    return { label: 'Обменять', disabled: !route, onClick: handleSwap }
  })()

  const feeBps = route ? routeFeeBps(route) : 0

  // Обратный курс: сколько tokenIn за 1 tokenOut.
  const rate = useMemo(() => {
    if (!route || amountIn <= 0n || amountOut === 0n) return null
    const num = amountOut * 10n ** BigInt(tokenIn.decimals)
    return {
      value: num / amountIn,
      decimals: tokenOut.decimals,
    }
  }, [route, amountIn, amountOut, tokenIn, tokenOut])

  return (
    <>
      <div className="card">
        <div className="swap-head">
          <h1>Обмен</h1>
          <button className="settings-toggle" onClick={() => setShowSettings((v) => !v)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {formatBps(slippageBps)}
          </button>
        </div>

        {showSettings && (
          <div className="settings-panel">
            {SLIPPAGE_OPTIONS.map((bps) => (
              <button
                key={bps}
                className={slippageBps === bps ? 'slippage-opt active' : 'slippage-opt'}
                onClick={() => setSlippageBps(bps)}
              >
                {formatBps(bps)}
              </button>
            ))}
          </div>
        )}

        {/* вход */}
        <div className="token-box">
          <div className="token-box-head">
            <span>Отдаёте</span>
          </div>
          <div className="token-box-body">
            <input
              className="amount-input"
              inputMode="decimal"
              placeholder="0"
              value={amountInStr}
              onChange={(e) => {
                const v = e.target.value
                if (v === '' || /^\d*\.?\d*$/.test(v)) setAmountInStr(v)
              }}
            />
            <button className="token-select" onClick={() => setPickerFor('in')}>
              <TokenIcon token={tokenIn} />
              {tokenIn.symbol}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </div>
          <div className="balance-row">
            <span>
              {account
                ? `Баланс: ${balances[tokenIn.address.toLowerCase()] ?? '—'} ${tokenIn.symbol}`
                : ''}
            </span>
            {account && balanceInRaw !== null && balanceInRaw > 0n && (
              <button onClick={handleMax}>МАКС</button>
            )}
          </div>
        </div>

        <button className="switch-btn" onClick={handleSwitchTokens} aria-label="Поменять местами">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4" />
          </svg>
        </button>

        {/* выход */}
        <div className="token-box">
          <div className="token-box-head">
            <span>Получаете</span>
          </div>
          <div className="token-box-body">
            <input
              className="amount-input"
              placeholder="0"
              readOnly
              value={
                route && amountOut > 0n
                  ? formatAmount(amountOut, tokenOut.decimals, 8)
                  : quoting
                    ? '…'
                    : ''
              }
            />
            <button className="token-select" onClick={() => setPickerFor('out')}>
              <TokenIcon token={tokenOut} />
              {tokenOut.symbol}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <path d="M6 9l6 6 6-6" />
              </svg>
            </button>
          </div>
          <div className="balance-row">
            <span>
              {account && route
                ? `Мин. получите: ${formatAmount(minReceived, tokenOut.decimals, 8)} ${tokenOut.symbol}`
                : ''}
            </span>
          </div>
        </div>

        {/* детали */}
        {route && (
          <div className="details">
            <div className="detail-row">
              <span>Маршрут</span>
              <RouteBadges hops={route.hops} />
            </div>
            {rate && (
              <div className="detail-row">
                <span>Курс</span>
                <span className="mono">
                  1 {tokenIn.symbol} = {formatAmount(rate.value, rate.decimals, 6)} {tokenOut.symbol}
                </span>
              </div>
            )}
            <div
              className={
                route.priceImpactBps >= 300
                  ? 'detail-row bad'
                  : route.priceImpactBps >= 100
                    ? 'detail-row warn'
                    : 'detail-row'
              }
            >
              <span>Влияние на цену</span>
              <span>{formatBps(route.priceImpactBps)}</span>
            </div>
            {route.priceImpactBps > 0 && <ImpactBar bps={route.priceImpactBps} />}
            <div className="detail-row">
              <span>Комиссия пула</span>
              <span>{formatBps(feeBps)}</span>
            </div>
            <div className="detail-row">
              <span>Проскальзывание</span>
              <span>{formatBps(slippageBps)}</span>
            </div>
          </div>
        )}

        {/* статусы */}
        {quoteError && !quoting && <Notice kind="error">{quoteError}</Notice>}

        {insufficientBalance && <Notice kind="warn">Недостаточно {tokenIn.symbol} на балансе</Notice>}

        {route && route.priceImpactBps >= 500 && (
          <Notice kind="warn">
            Влияние на цену {formatBps(route.priceImpactBps)}. В пуле мало ликвидности — вы получите
            заметно меньше, чем по текущему курсу.
          </Notice>
        )}

        {txState.status === 'error' && txState.error && <Notice kind="error">{txState.error}</Notice>}

        {txState.status === 'success' && txState.hash && (
          <Notice kind="success">
            Готово.{' '}
            <a href={`https://bscscan.com/tx/${txState.hash}`} target="_blank" rel="noreferrer">
              Открыть в BscScan
            </a>
          </Notice>
        )}

        {txState.status === 'pending' && txState.hash && (
          <Notice kind="info">
            Транзакция в сети.{' '}
            <a href={`https://bscscan.com/tx/${txState.hash}`} target="_blank" rel="noreferrer">
              BscScan
            </a>
          </Notice>
        )}

        {buttonState.href ? (
          <a
            className="primary-btn"
            href={buttonState.href}
            target="_blank"
            rel="noreferrer"
            style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}
          >
            {buttonState.label}
          </a>
        ) : (
          <button
            className={buttonState.approve ? 'primary-btn approve' : 'primary-btn'}
            disabled={buttonState.disabled}
            onClick={buttonState.onClick}
          >
            {buttonState.spinner && <Spinner light />}
            {buttonState.label}
          </button>
        )}
      </div>

      {pickerFor && (
        <TokenPicker
          tokens={tokens}
          exclude={pickerFor === 'in' ? tokenOut.address : tokenIn.address}
          balances={balances}
          onAddToken={handleAddToken}
          onClose={() => setPickerFor(null)}
          onSelect={(t) => {
            if (pickerFor === 'in') {
              if (t.address === tokenOut.address) setTokenOut(tokenIn)
              setTokenIn(t)
            } else {
              if (t.address === tokenIn.address) setTokenIn(tokenOut)
              setTokenOut(t)
            }
            setPickerFor(null)
            setRoute(null)
          }}
        />
      )}
    </>
  )
}

// Человеческие сообщения вместо сырых ошибок кошелька.
function friendlyError(e) {
  const msg = e?.message ?? String(e)
  if (e?.code === 4001 || /user rejected|denied/i.test(msg)) return 'Вы отклонили транзакцию в кошельке'
  if (/insufficient funds/i.test(msg)) return 'Недостаточно BNB для оплаты газа'
  if (/TRANSFER_FROM_FAILED/i.test(msg)) return 'Не удалось списать токен: проверьте разрешение (approve)'
  if (/INSUFFICIENT_OUTPUT_AMOUNT/i.test(msg))
    return 'Цена ушла: увеличьте проскальзывание или обновите котировку'
  if (/EXPIRED/i.test(msg)) return 'Истекло время транзакции, попробуйте снова'
  if (/reverted/i.test(msg)) return 'Транзакция отменена сетью (revert)'
  return msg.length > 160 ? msg.slice(0, 160) + '…' : msg
}
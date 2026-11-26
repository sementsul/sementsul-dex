import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  buildAddLiquidityV2,
  buildRemoveLiquidityV2,
  buildMintV3,
  buildBurnV3,
  buildCollectV3,
  readLpBalance,
  readLpSupply,
  readV3Position,
} from '../lib/liquidity.js'
import { readBalanceOf, readAllowance } from '../lib/pools.js'
import { parseAmount, formatAmount, formatUsd } from '../lib/format.js'
import { sendTransaction, waitForReceipt } from '../lib/wallet.js'
import { V2_ROUTER } from '../lib/chain.js'
import { SEL, encAddress, encUint } from '../lib/abi.js'
import { TokenIcon, Notice, Spinner, CopyAddress } from './ui.jsx'

const MAX_UINT256 = (1n << 256n) - 1n

// Экран ликвидности одного пула: добавить и вывести.
//
// Для V2 всё просто: две суммы, пропорция задаётся резервами, на выходе
// LP-токен, который можно сжечь и получить обратно оба токена.
//
// Для V3 иначе: вы задаёте диапазон цены, и позиция — это отдельный объект,
// а не доля в общем котле. Позиций может быть несколько, каждая со своим
// диапазоном, поэтому «вывести всё» здесь не существует.
export function LiquidityPanel({ pool, wallet, onBack, onDone }) {
  const isV3 = pool.protocol === 'v3'
  const [mode, setMode] = useState('add')

  return (
    <div className="page">
      <button className="back-btn" onClick={onBack}>
        ← Назад к пулам
      </button>

      <div className="pool-hero">
        <span className="pool-icons big">
          <TokenIcon token={pool.token0} size={32} />
          <TokenIcon token={pool.token1} size={32} />
        </span>
        <div>
          <h1 className="page-title inline">
            {pool.token0.symbol} / {pool.token1.symbol}
          </h1>
          <div className="pool-hero-meta">
            <span className={isV3 ? 'badge v3' : 'badge'}>{isV3 ? 'V3' : 'V2'}</span>
            {isV3 && <span className="dim mono">{(pool.fee / 10000).toFixed(2)}%</span>}
            <CopyAddress address={pool.address} chars={6} />
          </div>
        </div>
        <div className="pool-hero-tvl">
          <span className="dim">TVL</span>
          <span className="mono">{pool.tvl === null ? '—' : formatUsd(pool.tvl)}</span>
        </div>
      </div>

      <div className="segmented tabs">
        <button className={mode === 'add' ? 'seg active' : 'seg'} onClick={() => setMode('add')}>
          Добавить
        </button>
        <button
          className={mode === 'remove' ? 'seg active' : 'seg'}
          onClick={() => setMode('remove')}
        >
          Вывести
        </button>
      </div>

      {isV3 ? (
        mode === 'add' ? (
          <AddV3 pool={pool} wallet={wallet} onDone={onDone} />
        ) : (
          <RemoveV3 pool={pool} wallet={wallet} onDone={onDone} />
        )
      ) : mode === 'add' ? (
        <AddV2 pool={pool} wallet={wallet} onDone={onDone} />
      ) : (
        <RemoveV2 pool={pool} wallet={wallet} onDone={onDone} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Общее: одобрение токена
// ---------------------------------------------------------------------------

// Разрешение тратить токен. spender обязателен и обязателен осознанно: для
// V2 это роутер (он переводит токены в пару), для V3 — сам пул (он забирает
// их напрямую). Если передать не тот адрес, approve уйдёт в никуда, а
// следующая транзакция откатится с непонятной ошибкой.
//
// Ждём подтверждения каждого approve: отправить approve и mint подряд, не
// дожидаясь первого, нельзя — вторая транзакция может попасть в блок раньше.
async function ensureAllowance({ token, owner, spender, amount }) {
  if (!amount || amount === 0n) return
  const current = await readAllowance(token, owner, spender)
  if (current >= amount) return

  const hash = await sendTransaction({
    to: token,
    data: SEL.approve + encAddress(spender) + encUint(MAX_UINT256),
    value: 0n,
  })
  await waitForReceipt(hash)
}

// ---------------------------------------------------------------------------
// V2: добавление
// ---------------------------------------------------------------------------

function AddV2({ pool, wallet, onDone }) {
  const compliance = wallet.compliance ?? {}
  const blocked = compliance.blocked ?? false
  const { account } = wallet
  const [val0, setVal0] = useState('')
  const [val1, setVal1] = useState('')
  const [bal0, setBal0] = useState(null)
  const [bal1, setBal1] = useState(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)

  const poolEmpty = pool.reserve0 === 0n && pool.reserve1 === 0n

  // Пропорция. В существующем пуле вторая сумма вычисляется из первой:
  // добавить «как хочу» нельзя — пул принимает только в той пропорции, которая
  // уже есть, иначе изменилась бы цена, а это уже обмен, а не ликвидность.
  const onVal0 = (v) => {
    setVal0(v)
    if (poolEmpty) return
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) {
      setVal1('')
      return
    }
    const r0 = Number(pool.reserve0) / 10 ** pool.token0.decimals
    const r1 = Number(pool.reserve1) / 10 ** pool.token1.decimals
    if (r0 === 0) return
    setVal1(String((n * r1) / r0))
  }

  const loadBals = useCallback(async () => {
    if (!account) return
    const [b0, b1] = await Promise.all([
      readBalanceOf(pool.token0.address, account),
      readBalanceOf(pool.token1.address, account),
    ])
    setBal0(b0)
    setBal1(b1)
  }, [account, pool.token0.address, pool.token1.address])

  useEffect(() => {
    loadBals().catch(() => {})
  }, [loadBals])

  const amt0 = useMemo(
    () => parseAmount(val0, pool.token0.decimals),
    [val0, pool.token0.decimals]
  )
  const amt1 = useMemo(
    () => parseAmount(val1, pool.token1.decimals),
    [val1, pool.token1.decimals]
  )

  const insufficient = (bal0 !== null && amt0 > bal0) || (bal1 !== null && amt1 > bal1)
  const canAdd = account && amt0 > 0n && amt1 > 0n && !insufficient && !busy

  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus('Подтвердите одобрение токенов…')
      await ensureAllowance({
        token: pool.token0.address,
        owner: account,
        spender: V2_ROUTER,
        amount: amt0,
      })
      await ensureAllowance({
        token: pool.token1.address,
        owner: account,
        spender: V2_ROUTER,
        amount: amt1,
      })

      setStatus('Подтвердите добавление ликвидности…')
      const tx = buildAddLiquidityV2({
        tokenA: pool.token0.address,
        tokenB: pool.token1.address,
        amountADesired: amt0,
        amountBDesired: amt1,
        slippageBps: 50,
        to: account,
      })
      const hash = await sendTransaction(tx)
      setStatus('Ждём подтверждения…')
      await waitForReceipt(hash)
      setStatus('Ликвидность добавлена.')
      onDone?.()
    } catch (e) {
      setError(e?.shortMessage || e?.message || String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card form-card">
      <AmountField
        token={pool.token0}
        value={val0}
        onChange={onVal0}
        balance={bal0}
        disabled={busy}
      />
      <AmountField
        token={pool.token1}
        value={val1}
        onChange={setVal1}
        balance={bal1}
        disabled={busy || !poolEmpty}
        hint={poolEmpty ? 'Первый поставщик задаёт цену' : 'Считается по пропорции пула'}
      />

      {poolEmpty && (
        <Notice kind="warn">
          Пул пуст. Соотношение сумм, которое вы введёте, станет начальной ценой для всех.
          Если цена окажется неверной, арбитражники заберут разницу.
        </Notice>
      )}

      {insufficient && <Notice kind="error">Недостаточно средств на балансе.</Notice>}
      {status && (
        <Notice kind="info">
          {busy && <Spinner />} {status}
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}

      {/* Комплаенс: причина видна до нажатия, а не только после отказа
          кошелька. Кнопка ниже блокируется тем же флагом. */}
      {blocked && <Notice kind="error">{compliance.reason}</Notice>}

      <button className="primary-btn" disabled={!canAdd || blocked} onClick={add}>
        {blocked
          ? 'Операции заблокированы'
          : !account
            ? 'Сначала подключите кошелёк'
            : busy
              ? 'Добавляем…'
              : 'Добавить ликвидность'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// V2: вывод
// ---------------------------------------------------------------------------

function RemoveV2({ pool, wallet, onDone }) {
  const compliance = wallet.compliance ?? {}
  const blocked = compliance.blocked ?? false
  const { account } = wallet
  const [lp, setLp] = useState(null)
  const [supply, setSupply] = useState(null)
  const [pct, setPct] = useState(50)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!account) return
    Promise.all([readLpBalance(pool.address, account), readLpSupply(pool.address)])
      .then(([b, s]) => {
        setLp(b)
        setSupply(s)
      })
      .catch(() => {})
  }, [account, pool.address])

  const liquidity = useMemo(() => {
    if (!lp) return 0n
    return (lp * BigInt(pct)) / 100n
  }, [lp, pct])

  const out = useMemo(() => {
    if (!supply || liquidity === 0n) return null
    return {
      r0: (pool.reserve0 * liquidity) / supply,
      r1: (pool.reserve1 * liquidity) / supply,
    }
  }, [supply, liquidity, pool.reserve0, pool.reserve1])

  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus('Подтвердите вывод ликвидности…')
      const tx = buildRemoveLiquidityV2({
        tokenA: pool.token0.address,
        tokenB: pool.token1.address,
        liquidity,
        to: account,
      })
      const hash = await sendTransaction(tx)
      setStatus('Ждём подтверждения…')
      await waitForReceipt(hash)
      setStatus('Ликвидность выведена.')
      onDone?.()
    } catch (e) {
      setError(e?.shortMessage || e?.message || String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  if (!account) {
    return (
      <div className="card form-card">
        <Notice kind="info">Подключите кошелёк, чтобы увидеть свою позицию.</Notice>
      </div>
    )
  }

  return (
    <div className="card form-card">
      <div className="position-box">
        <span className="dim">Ваши LP-токены</span>
        <span className="mono">{lp === null ? '…' : formatAmount(lp, 18, 6)}</span>
      </div>

      <div className="form-field">
        <label>Сколько вывести</label>
        <div className="pct-row">
          {[25, 50, 75, 100].map((p) => (
            <button
              key={p}
              className={pct === p ? 'pct-btn active' : 'pct-btn'}
              onClick={() => setPct(p)}
            >
              {p === 100 ? 'Всё' : `${p}%`}
            </button>
          ))}
        </div>
      </div>

      {out && (
        <div className="quote-details">
          <div className="detail-row">
            <span>Получите {pool.token0.symbol}</span>
            <span className="mono">{formatAmount(out.r0, pool.token0.decimals, 6)}</span>
          </div>
          <div className="detail-row">
            <span>Получите {pool.token1.symbol}</span>
            <span className="mono">{formatAmount(out.r1, pool.token1.decimals, 6)}</span>
          </div>
        </div>
      )}

      {status && (
        <Notice kind="info">
          {busy && <Spinner />} {status}
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}

      {blocked && <Notice kind="error">{compliance.reason}</Notice>}

      <button className="primary-btn" disabled={liquidity === 0n || busy || blocked} onClick={remove}>
        {blocked
          ? 'Операции заблокированы'
          : busy
            ? 'Выводим…'
            : liquidity > 0n
              ? 'Вывести ликвидность'
              : 'Нет LP-токенов'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// V3: задать начальную цену
// ---------------------------------------------------------------------------

// Пустой V3-пул не имеет цены, и до её установки ни свопы, ни ликвидность
// невозможны: суммы токенов для диапазона считаются из sqrtPriceX96.
//
// Цену задаём как «сколько token1 за 1 token0» — так это привычнее читать.
// В контракт уходит sqrtPriceX96 = sqrt(price) * 2^96 с поправкой на decimals.
export function SetPrice({ pool, wallet, onDone }) {
  const compliance = wallet.compliance ?? {}
  const blocked = compliance.blocked ?? false
  const [price, setPrice] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [status, setStatus] = useState(null)

  const sqrtPrice = useMemo(() => {
    const n = Number(price)
    if (!Number.isFinite(n) || n <= 0) return null
    // Приводим «человеческую» цену к «сырой»: цена в контракте — это отношение
    // наименьших единиц, поэтому decimals входят в показатель степени.
    const raw = n * 10 ** (pool.token1.decimals - pool.token0.decimals)
    if (!(raw > 0)) return null
    const sqrt = Math.sqrt(raw) * 2 ** 96
    if (!Number.isFinite(sqrt) || sqrt <= 0) return null
    return BigInt(Math.floor(sqrt))
  }, [price, pool.token0.decimals, pool.token1.decimals])

  const set = async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus('Подтвердите установку цены…')
      const hash = await sendTransaction({
        to: pool.address,
        data: SEL.initializePrice + encUint(sqrtPrice),
        value: 0n,
      })
      setStatus('Ждём подтверждения…')
      await waitForReceipt(hash)
      setStatus('Цена установлена.')
      onDone?.()
    } catch (e) {
      setError(e?.shortMessage || e?.message || String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="form-field">
        <label>
          Начальная цена: сколько {pool.token1.symbol} за 1 {pool.token0.symbol}
        </label>
        <div className="amount-wrap">
          <input
            className="amount-input mono"
            inputMode="decimal"
            placeholder="0.0"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
          />
          <span className="amount-token">{pool.token1.symbol}</span>
        </div>
        {sqrtPrice && (
          <span className="field-hint mono">
            sqrtPriceX96 = {sqrtPrice.toString()}
          </span>
        )}
      </div>

      <Notice kind="warn">
        Цену можно задать только один раз, и отменить это нельзя. Ставьте ту, что близка к
        рыночной: если она будет ниже, кто-то сразу купит токен дешевле, чем он стоит.
      </Notice>

      {status && (
        <Notice kind="info">
          {busy && <Spinner />} {status}
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {blocked && <Notice kind="error">{compliance.reason}</Notice>}

      <button
        className="primary-btn"
        disabled={!sqrtPrice || busy || !wallet.account || blocked}
        onClick={set}
      >
        {blocked ? 'Операции заблокированы' : busy ? 'Устанавливаем…' : 'Установить цену'}
      </button>
    </>
  )
}

// ---------------------------------------------------------------------------
// V3: добавление ликвидности
// ---------------------------------------------------------------------------

function AddV3({ pool, wallet, onDone }) {
  const compliance = wallet.compliance ?? {}
  const blocked = compliance.blocked ?? false
  const { account } = wallet
  const [range, setRange] = useState(10)
  const [amount, setAmount] = useState('')
  const [bal0, setBal0] = useState(null)
  const [bal1, setBal1] = useState(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!account) return
    Promise.all([
      readBalanceOf(pool.token0.address, account),
      readBalanceOf(pool.token1.address, account),
    ])
      .then(([b0, b1]) => {
        setBal0(b0)
        setBal1(b1)
      })
      .catch(() => {})
  }, [account, pool.token0.address, pool.token1.address])

  // Тики из процентов. Цена растёт как 1.0001^tick, поэтому приращение тика —
  // это ln(1 + pct) / ln(1.0001). Округляем к сетке tickSpacing: контракт
  // отвергнет тик, не кратный шагу, и пользователь увидит непонятную ошибку.
  const tickSpacing = pool.tickSpacing || 10
  const ticks = useMemo(() => {
    const currentTick = pool.tick
    const delta = Math.round(Math.log(1 + range / 100) / Math.log(1.0001))
    const lower = Math.floor((currentTick - delta) / tickSpacing) * tickSpacing
    const upper = Math.ceil((currentTick + delta) / tickSpacing) * tickSpacing
    return { lower, upper }
  }, [pool.tick, range, tickSpacing])

  // Сумма liquidity — не «сколько токенов», а множитель в формуле x*y=k внутри
  // диапазона. Для оценки берём сумму первого токена и считаем L по формуле
  // L = amount * sqrt(P) для диапазона вокруг текущей цены. Точный расчёт
  // сделает контракт; здесь важно не дать пользователю ввести бессмыслицу.
  const amountBig = useMemo(
    () => parseAmount(amount, pool.token0.decimals),
    [amount, pool.token0.decimals]
  )
  const liquidity = useMemo(() => {
    if (amountBig === 0n) return 0n
    const sqrtLower = Math.sqrt(1 / (1 + range / 100))
    // Для узкого диапазона L примерно равно amount / (1 - sqrtLower).
    const denom = 1 - sqrtLower
    if (!(denom > 0)) return amountBig
    return BigInt(Math.floor(Number(amountBig) / denom))
  }, [amountBig, range])

  const priceUnset = pool.sqrtPriceX96 === 0n

  const add = async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus('Подтвердите одобрение токенов…')
      // V3-пул забирает токены сам через transferFrom, поэтому одобрение
      // выдаётся на адрес пула, а не роутера.
      await ensureAllowance({
        token: pool.token0.address,
        owner: account,
        spender: pool.address,
        amount: amountBig,
      })
      await ensureAllowance({
        token: pool.token1.address,
        owner: account,
        spender: pool.address,
        amount: amountBig,
      })

      setStatus('Подтвердите создание позиции…')
      const tx = buildMintV3({
        pool: pool.address,
        recipient: account,
        tickLower: ticks.lower,
        tickUpper: ticks.upper,
        liquidity,
      })
      const hash = await sendTransaction(tx)
      setStatus('Ждём подтверждения…')
      await waitForReceipt(hash)
      setStatus('Позиция создана.')
      onDone?.()
    } catch (e) {
      setError(e?.shortMessage || e?.message || String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  if (priceUnset) {
    return (
      <div className="card form-card">
        <Notice kind="warn">
          В этом пуле ещё не задана начальная цена. Без неё неизвестно, сколько токенов
          соответствует диапазону, поэтому добавлять ликвидность нельзя.
        </Notice>
        <SetPrice pool={pool} wallet={wallet} onDone={onDone} />
      </div>
    )
  }

  return (
    <div className="card form-card">
      <div className="form-field">
        <label>Диапазон цены</label>
        <div className="pct-row">
          {[1, 2, 5, 10, 50].map((r) => (
            <button
              key={r}
              className={range === r ? 'pct-btn active' : 'pct-btn'}
              onClick={() => setRange(r)}
            >
              ±{r}%
            </button>
          ))}
        </div>
        <p className="fine-print">
          Узкий диапазон приносит больше комиссий на тот же капитал, но если цена выйдет за
          границы, позиция перестанет зарабатывать и останется в одном токене.
        </p>
      </div>

      <div className="form-field">
        <label>Тики</label>
        <div className="tick-row mono">
          <span>нижний: {ticks.lower}</span>
          <span>верхний: {ticks.upper}</span>
        </div>
      </div>

      <AmountField
        token={pool.token0}
        value={amount}
        onChange={setAmount}
        balance={bal0}
        disabled={busy}
        hint="Ориентировочная сумма в первом токене"
      />

      {status && (
        <Notice kind="info">
          {busy && <Spinner />} {status}
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {blocked && <Notice kind="error">{compliance.reason}</Notice>}

      <button
        className="primary-btn"
        disabled={!account || liquidity === 0n || busy || blocked}
        onClick={add}
      >
        {blocked
          ? 'Операции заблокированы'
          : !account
            ? 'Сначала подключите кошелёк'
            : busy
              ? 'Добавляем…'
              : 'Создать позицию'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// V3: вывод ликвидности
// ---------------------------------------------------------------------------

// Вывод позиции V3 требует знать её диапазон: контракт хранит позиции по
// ключу keccak256(owner, lower, upper) и перечислить их не умеет. Поэтому
// диапазон вводится вручную — и только потом читается позиция.
//
// Ввести неверный диапазон не опасно: readV3Position вернёт null, и кнопка
// останется выключенной.
function RemoveV3({ pool, wallet, onDone }) {
  const compliance = wallet.compliance ?? {}
  const blocked = compliance.blocked ?? false
  const { account } = wallet
  const [lower, setLower] = useState('')
  const [upper, setUpper] = useState('')
  const [pos, setPos] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)

  const lowerN = Number(lower)
  const upperN = Number(upper)
  const validRange =
    Number.isFinite(lowerN) && Number.isFinite(upperN) && lowerN < upperN && lower !== '' && upper !== ''

  const check = async () => {
    setError(null)
    setPos(undefined)
    try {
      const p = await readV3Position(pool.address, account, lowerN, upperN)
      setPos(p)
      if (!p) setError('По этому диапазону позиций не найдено.')
    } catch (e) {
      setError(e?.message || String(e))
    }
  }

  const withdraw = async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus('Подтвердите снятие ликвидности…')
      const burnTx = buildBurnV3({
        pool: pool.address,
        tickLower: lowerN,
        tickUpper: upperN,
        liquidity: pos.liquidity,
      })
      let hash = await sendTransaction(burnTx)
      setStatus('Ждём подтверждения…')
      await waitForReceipt(hash)

      setStatus('Забираем токены и комиссии…')
      const collectTx = buildCollectV3({
        pool: pool.address,
        recipient: account,
        tickLower: lowerN,
        tickUpper: upperN,
      })
      hash = await sendTransaction(collectTx)
      await waitForReceipt(hash)

      setStatus('Средства выведены.')
      onDone?.()
    } catch (e) {
      setError(e?.shortMessage || e?.message || String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  if (!account) {
    return (
      <div className="card form-card">
        <Notice kind="info">Подключите кошелёк, чтобы увидеть свою позицию.</Notice>
      </div>
    )
  }

  return (
    <div className="card form-card">
      <div className="form-field">
        <label>Диапазон позиции</label>
        <div className="tick-inputs">
          <input
            className="search-input mono"
            placeholder="нижний тик"
            inputMode="numeric"
            value={lower}
            onChange={(e) => {
              setLower(e.target.value)
              setPos(undefined)
            }}
          />
          <input
            className="search-input mono"
            placeholder="верхний тик"
            inputMode="numeric"
            value={upper}
            onChange={(e) => {
              setUpper(e.target.value)
              setPos(undefined)
            }}
          />
        </div>
        <p className="fine-print">
          Диапазон указан в тиках — это те числа, что вы видели при создании позиции. Шаг тика
          для этого пула: {pool.tickSpacing || 10}.
        </p>
      </div>

      <button className="ghost-btn" disabled={!validRange || busy} onClick={check}>
        Проверить позицию
      </button>

      {pos === null && <Notice kind="warn">По этому диапазону позиций нет.</Notice>}

      {pos && (
        <div className="quote-details">
          <div className="detail-row">
            <span>Ликвидность</span>
            <span className="mono">{pos.liquidity.toString()}</span>
          </div>
          <div className="detail-row">
            <span>Комиссии {pool.token0.symbol}</span>
            <span className="mono">{formatAmount(pos.tokensOwed0, pool.token0.decimals, 6)}</span>
          </div>
          <div className="detail-row">
            <span>Комиссии {pool.token1.symbol}</span>
            <span className="mono">{formatAmount(pos.tokensOwed1, pool.token1.decimals, 6)}</span>
          </div>
          {(pos.pending0 > 0n || pos.pending1 > 0n) && (
            <>
              <div className="detail-row">
                <span>Отлеживается {pool.token0.symbol}</span>
                <span className="mono">{formatAmount(pos.pending0, pool.token0.decimals, 6)}</span>
              </div>
              <div className="detail-row">
                <span>Отлеживается {pool.token1.symbol}</span>
                <span className="mono">{formatAmount(pos.pending1, pool.token1.decimals, 6)}</span>
              </div>
            </>
          )}
        </div>
      )}

      {pos && (pos.pending0 > 0n || pos.pending1 > 0n) && (
        <Notice kind="info">
          Часть комиссии ещё отлеживается до блока {pos.vestBlock.toString()} — это защита от
          JIT-ботов. Она станет доступной после этого блока, но только если вы не снимете
          ликвидность раньше: досрочное снятие сжигает соразмерную долю отлеживающегося.
        </Notice>
      )}

      {status && (
        <Notice kind="info">
          {busy && <Spinner />} {status}
        </Notice>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      {blocked && <Notice kind="error">{compliance.reason}</Notice>}

      <button className="primary-btn" disabled={!pos || busy || blocked} onClick={withdraw}>
        {blocked ? 'Операции заблокированы' : busy ? 'Выводим…' : 'Забрать всё'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Поле суммы
// ---------------------------------------------------------------------------

function AmountField({ token, value, onChange, balance, disabled, hint }) {
  return (
    <div className="form-field">
      <div className="field-head">
        <label>{token.symbol}</label>
        {balance !== null && (
          <button
            className="link-btn"
            onClick={() => onChange(formatAmount(balance, token.decimals, 8, { group: false }))}
            disabled={disabled}
          >
            макс: {formatAmount(balance, token.decimals, 4)}
          </button>
        )}
      </div>
      <div className="amount-wrap">
        <input
          className="amount-input mono"
          inputMode="decimal"
          placeholder="0.0"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
        />
        <span className="amount-token">
          <TokenIcon token={token} size={20} />
          {token.symbol}
        </span>
      </div>
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  )
}
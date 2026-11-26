import { useMemo, useState } from 'react'
import {
  KNOWN_TOKENS,
  WBNB,
  HAS_OWN_DEX,
  HAS_OWN_V3,
  OWN_V3_TIERS,
} from '../lib/chain.js'
import { buildCreatePair, buildCreatePool } from '../lib/liquidity.js'
import { sendTransaction, waitForReceipt } from '../lib/wallet.js'
import { findV2Pair } from '../lib/pools.js'
import { TokenIcon, TokenPicker, Notice, Spinner } from './ui.jsx'

// Создание пула.
//
// Разрешения не спрашиваем: контракт их тоже не спрашивает. Но показать, что
// именно произойдёт, обязаны — новый пул стартует с нулевой ликвидностью и
// нулевой ценой, и первый, кто добавит туда токены, задаёт цену сам. Второй
// поставщик обязан с ней считаться, иначе он подарит первому часть своих денег.
export default function CreatePool({ wallet, onBack, onCreated }) {
  const [tokenA, setTokenA] = useState(null)
  const [tokenB, setTokenB] = useState(null)
  const [pickerFor, setPickerFor] = useState(null)
  const [version, setVersion] = useState('v2')
  // Тир комиссии для V3. Одна фабрика держит по пулу на каждый тир, поэтому
  // при создании нужно выбрать, какой именно заводим: это не «настройка пула»,
  // а выбор самого пула.
  const [v3Fee, setV3Fee] = useState(OWN_V3_TIERS[0].fee)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [existing, setExisting] = useState(undefined)

  const { account } = wallet
  const compliance = wallet.compliance ?? {}
  const blocked = compliance.blocked ?? false

  const tokens = useMemo(() => KNOWN_TOKENS.filter((t) => !t.native), [])

  // Проверяем, нет ли уже пары. Отдельный запрос на каждую смену токена:
  // пользователь должен узнать «пара уже есть» до подписи, а не после.
  const checkExisting = async (a, b) => {
    if (!a || !b) {
      setExisting(undefined)
      return
    }
    if (!HAS_OWN_DEX) {
      setExisting(null)
      return
    }
    try {
      const p = await findV2Pair(a.address, b.address)
      setExisting(p)
    } catch {
      setExisting(null)
    }
  }

  const pick = (token) => {
    if (pickerFor === 'a') {
      setTokenA(token)
      checkExisting(token, tokenB)
    } else {
      setTokenB(token)
      checkExisting(tokenA, token)
    }
    setPickerFor(null)
    setError(null)
    setStatus(null)
  }

  const identical = tokenA && tokenB && tokenA.address.toLowerCase() === tokenB.address.toLowerCase()
  const canCreate = tokenA && tokenB && !identical && account && !busy

  const create = async () => {
    setBusy(true)
    setError(null)
    setStatus('Подтвердите транзакцию в кошельке…')
    try {
      let tx
      if (version === 'v2') {
        // Нативный BNB пулом не является: в пуле его представляет WBNB.
        // Если пользователь выбрал BNB, подменяем на WBNB, иначе createPair
        // создал бы пару с адресом-заглушкой.
        const a = tokenA.native ? WBNB : tokenA.address
        const b = tokenB.native ? WBNB : tokenB.address
        tx = buildCreatePair(a, b)
      } else {
        const a = tokenA.native ? WBNB : tokenA.address
        const b = tokenB.native ? WBNB : tokenB.address
        tx = buildCreatePool(a, b, v3Fee)
      }

      const hash = await sendTransaction(tx)
      setStatus('Ждём подтверждения…')
      await waitForReceipt(hash)
      setStatus('Пул создан.')
      onCreated?.()
    } catch (e) {
      setError(e?.shortMessage || e?.message || String(e))
      setStatus(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <button className="back-btn" onClick={onBack}>
        ← Назад к пулам
      </button>

      <h1 className="page-title">Создать пул</h1>
      <p className="page-sub">
        Новый пул начинает с нуля: ни ликвидности, ни цены. Первый поставщик задаёт цену,
        остальные к ней присоединяются.
      </p>

      <div className="card form-card">
        <div className="form-field">
          <label>Первый токен</label>
          <button className="token-select wide" onClick={() => setPickerFor('a')}>
            {tokenA ? (
              <>
                <TokenIcon token={tokenA} size={22} />
                <span>{tokenA.symbol}</span>
              </>
            ) : (
              <span className="dim">Выбрать токен</span>
            )}
          </button>
        </div>

        <div className="form-field">
          <label>Второй токен</label>
          <button className="token-select wide" onClick={() => setPickerFor('b')}>
            {tokenB ? (
              <>
                <TokenIcon token={tokenB} size={22} />
                <span>{tokenB.symbol}</span>
              </>
            ) : (
              <span className="dim">Выбрать токен</span>
            )}
          </button>
        </div>

        <div className="form-field">
          <label>Тип пула</label>
          <div className="segmented">
            <button
              className={version === 'v2' ? 'seg active' : 'seg'}
              onClick={() => setVersion('v2')}
            >
              V2 · обычный
              <span className="seg-sub">вся цена в одном диапазоне</span>
            </button>
            <button
              className={version === 'v3' ? 'seg active' : 'seg'}
              onClick={() => setVersion('v3')}
              disabled={!HAS_OWN_V3}
              title={HAS_OWN_V3 ? '' : 'Концентратор ликвидности ещё не развёрнут'}
            >
              V3 · концентрированный
              <span className="seg-sub">ликвидность в выбранном диапазоне</span>
            </button>
          </div>
        </div>

        {version === 'v3' && (
          <div className="form-field">
            <label>Комиссия пула</label>
            <div className="tier-list">
              {OWN_V3_TIERS.map((t) => (
                <button
                  key={t.fee}
                  className={v3Fee === t.fee ? 'tier active' : 'tier'}
                  onClick={() => setV3Fee(t.fee)}
                >
                  <span className="tier-fee">{t.label}</span>
                  <span className="tier-hint">{t.hint}</span>
                </button>
              ))}
            </div>
            <p className="fine-print">
              Для одной пары можно создать по пулу на каждый тир — это разные пулы с
              разными адресами, и ликвидность в них не смешивается. Чем ниже комиссия,
              тем дешевле торговать и тем меньше зарабатывает поставщик ликвидности.
            </p>
          </div>
        )}

        {identical && <Notice kind="error">Это один и тот же токен — пул с самим собой невозможен.</Notice>}

        {existing && (
          <Notice kind="warn">
            Пара уже существует: <span className="mono">{existing}</span>. Создавать вторую не
            нужно — добавьте ликвидность в существующую.
          </Notice>
        )}

        {version === 'v3' && (
          <Notice kind="info">
            После создания V3-пула нужно задать начальную цену. Сделать это можно на странице
            пула — до этого обмен и ликвидность в нём недоступны.
          </Notice>
        )}

        {status && (
          <Notice kind="info">
            {busy && <Spinner />} {status}
          </Notice>
        )}

        {error && <Notice kind="error">{error}</Notice>}
        {blocked && <Notice kind="error">{compliance.reason}</Notice>}

        <button className="primary-btn" disabled={!canCreate || blocked} onClick={create}>
          {blocked
            ? 'Операции заблокированы'
            : !account
              ? 'Сначала подключите кошелёк'
              : busy
                ? 'Создаём…'
                : 'Создать пул'}
        </button>

        <p className="fine-print">
          Создание пула — это одна транзакция и небольшой расход газа. Комиссию за обмен
          устанавливает фабрика, а не создатель пула: подкрутить её в свою пользу нельзя.
        </p>
      </div>

      {pickerFor && (
        <TokenPicker
          tokens={tokens}
          exclude={pickerFor === 'a' ? tokenB?.address : tokenA?.address}
          onSelect={pick}
          onClose={() => setPickerFor(null)}
        />
      )}
    </div>
  )
}
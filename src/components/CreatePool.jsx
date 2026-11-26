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
import { useI18n } from '../lib/useI18n.jsx'

// Создание пула.
//
// Разрешения не спрашиваем: контракт их тоже не спрашивает. Но показать, что
// именно произойдёт, обязаны — новый пул стартует с нулевой ликвидностью и
// нулевой ценой, и первый, кто добавит туда токены, задаёт цену сам. Второй
// поставщик обязан с ней считаться, иначе он подарит первому часть своих денег.
export default function CreatePool({ wallet, onBack, onCreated }) {
  const { t } = useI18n()
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
    setStatus(t('create.confirmTx'))
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
      setStatus(t('tx.waiting'))
      await waitForReceipt(hash)
      setStatus(t('create.created'))
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
        {t('liq.backToPools')}
      </button>

      <h1 className="page-title">{t('create.title')}</h1>
      <p className="page-sub">{t('create.sub')}</p>

      <div className="card form-card">
        <div className="form-field">
          <label>{t('create.firstToken')}</label>
          <button className="token-select wide" onClick={() => setPickerFor('a')}>
            {tokenA ? (
              <>
                <TokenIcon token={tokenA} size={22} />
                <span>{tokenA.symbol}</span>
              </>
            ) : (
              <span className="dim">{t('create.chooseToken')}</span>
            )}
          </button>
        </div>

        <div className="form-field">
          <label>{t('create.secondToken')}</label>
          <button className="token-select wide" onClick={() => setPickerFor('b')}>
            {tokenB ? (
              <>
                <TokenIcon token={tokenB} size={22} />
                <span>{tokenB.symbol}</span>
              </>
            ) : (
              <span className="dim">{t('create.chooseToken')}</span>
            )}
          </button>
        </div>

        <div className="form-field">
          <label>{t('create.poolType')}</label>
          <div className="segmented">
            <button
              className={version === 'v2' ? 'seg active' : 'seg'}
              onClick={() => setVersion('v2')}
            >
              {t('create.v2')}
              <span className="seg-sub">{t('create.v2sub')}</span>
            </button>
            <button
              className={version === 'v3' ? 'seg active' : 'seg'}
              onClick={() => setVersion('v3')}
              disabled={!HAS_OWN_V3}
              title={HAS_OWN_V3 ? '' : t('create.v3notDeployed')}
            >
              {t('create.v3')}
              <span className="seg-sub">{t('create.v3sub')}</span>
            </button>
          </div>
        </div>

        {version === 'v3' && (
          <div className="form-field">
            <label>{t('create.fee')}</label>
            <div className="tier-list">
              {OWN_V3_TIERS.map((tier) => (
                <button
                  key={tier.fee}
                  className={v3Fee === tier.fee ? 'tier active' : 'tier'}
                  onClick={() => setV3Fee(tier.fee)}
                >
                  <span className="tier-fee">{tier.label}</span>
                  <span className="tier-hint">{t(tier.hintKey)}</span>
                </button>
              ))}
            </div>
            <p className="fine-print">{t('create.feeNote')}</p>
          </div>
        )}

        {identical && <Notice kind="error">{t('create.identical')}</Notice>}

        {existing && (
          <Notice kind="warn">
            {t('create.existsPrefix')} <span className="mono">{existing}</span>.{' '}
            {t('create.existsSuffix')}
          </Notice>
        )}

        {version === 'v3' && <Notice kind="info">{t('create.v3PriceNotice')}</Notice>}

        {status && (
          <Notice kind="info">
            {busy && <Spinner />} {status}
          </Notice>
        )}

        {error && <Notice kind="error">{error}</Notice>}
        {blocked && <Notice kind="error">{compliance.reason}</Notice>}

        <button className="primary-btn" disabled={!canCreate || blocked} onClick={create}>
          {blocked
            ? t('compliance.actionsBlocked')
            : !account
              ? t('create.connectFirst')
              : busy
                ? t('create.creating')
                : t('create.submit')}
        </button>

        <p className="fine-print">{t('create.finePrint')}</p>
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
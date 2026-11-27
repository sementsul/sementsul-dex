import { useState } from 'react'
import SwapCard from './components/SwapCard.jsx'
import RecentTrades from './components/RecentTrades.jsx'
import PoolsPage from './components/PoolsPage.jsx'
import KnowledgePage from './components/KnowledgePage.jsx'
import TermsPage from './components/TermsPage.jsx'
import BlockedScreen from './components/BlockedScreen.jsx'
import { useWallet } from './lib/useWallet.js'
import { useI18n } from './lib/useI18n.jsx'
import { shortAddress } from './lib/format.js'
import { CHAIN_ID } from './lib/chain.js'

const TABS = [
  { id: 'swap', key: 'nav.swap' },
  { id: 'pools', key: 'nav.pools' },
  { id: 'kb', key: 'nav.kb' },
]

export default function App() {
  const wallet = useWallet()
  const { lang, setLang, t } = useI18n()
  const [tab, setTab] = useState('swap')
  const compliance = wallet.compliance

  // Гео-блокировка заменяет весь интерфейс. Это не оверлей: под ним не
  // должно оставаться работающих кнопок, иначе блокировка обходится
  // удалением одного элемента через devtools.
  if (compliance.geoBlocked) {
    return (
      <BlockedScreen
        title={compliance.geoTitle}
        message={compliance.geoMessage}
        kind={compliance.geoKind}
      />
    )
  }

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}sml-256.png`} alt="Sementsul" onError={(e) => (e.currentTarget.style.display = 'none')} />
          <span>Sementsul</span>
          <span className="brand-sub">DEX</span>
        </div>

        <nav className="nav">
          {TABS.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? 'nav-tab active' : 'nav-tab'}
              onClick={() => setTab(item.id)}
            >
              {t(item.key)}
            </button>
          ))}
          <button
            className={tab === 'terms' ? 'nav-tab active' : 'nav-tab'}
            onClick={() => setTab('terms')}
          >
            {t('nav.terms')}
          </button>
        </nav>

        {/* Переключатель языка. Две кнопки, а не выпадающий список: языков
            два, и лишний клик по выпадашке здесь ни к чему. */}
        <div className="lang-switch" role="group" aria-label={t('lang.label')}>
          <button
            className={lang === 'ru' ? 'lang-btn active' : 'lang-btn'}
            onClick={() => setLang('ru')}
            aria-pressed={lang === 'ru'}
          >
            RU
          </button>
          <button
            className={lang === 'en' ? 'lang-btn active' : 'lang-btn'}
            onClick={() => setLang('en')}
            aria-pressed={lang === 'en'}
          >
            EN
          </button>
        </div>

        {wallet.available ? (
          wallet.account ? (
            <button
              className="wallet-btn connected"
              onClick={wallet.disconnect}
              title={t('wallet.disconnectHint')}
            >
              <span className="dot" />
              <span className="mono">{shortAddress(wallet.account)}</span>
              {wallet.wrongChain && (
                <span style={{ color: 'var(--red)', fontSize: 11, fontWeight: 700 }}>
                  {t('wallet.wrongChain')}
                </span>
              )}
              {compliance.addressBlocked && (
                <span style={{ color: 'var(--red)', fontSize: 11, fontWeight: 700 }}>
                  {t('wallet.blocked')}
                </span>
              )}
            </button>
          ) : (
            <button className="wallet-btn" onClick={wallet.connect}>
              {t('wallet.connect')}
            </button>
          )
        ) : (
          <a className="wallet-btn" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
            {t('wallet.install')}
          </a>
        )}
      </header>

      {/* Адрес в санкционном списке: показываем постоянную плашку над
          контентом. Интерфейс остаётся доступным для чтения — блокируются
          только операции, и причина видна всегда, а не только при клике. */}
      {compliance.addressBlocked && (
        <div className="compliance-banner" role="alert">
          <strong>{t('compliance.blockedTitle')}</strong> {compliance.addressMessage}
        </div>
      )}

      {/* Список санкций не загрузился — честно сообщаем, что проверка не
          выполнялась, вместо того чтобы молча пропустить адрес. */}
      {compliance.sanctionsUnavailable && !compliance.addressBlocked && (
        <div className="compliance-banner warn" role="status">
          {t('compliance.sanctionsUnavailable')}
        </div>
      )}

      {/* Проверка юрисдикции не выполнялась.
          Это состояние IPFS-зеркала: там нет Cloudflare Pages Functions, а
          значит и /api/geo. Раньше в этом случае проверка молча считалась
          пройденной, и посетитель из закрытой юрисдикции видел обычный
          интерфейс. Теперь говорим прямо: барьер на этом адресе не работает,
          и для операций есть основной сайт. */}
      {compliance.geoUnavailable && (
        <div className="compliance-banner warn" role="status">
          {t('compliance.geoUnavailable')}
        </div>
      )}

      <main className="main">
        {tab === 'swap' && (
          <div className="main-col">
            <SwapCard wallet={wallet} />
            <RecentTrades />
          </div>
        )}
        {tab === 'pools' && <PoolsPage wallet={wallet} />}
        {tab === 'kb' && <KnowledgePage />}
        {tab === 'terms' && <TermsPage onBack={() => setTab('swap')} />}
      </main>

      <footer className="footer">
        <div className="footer-links">
          <a href="https://bscscan.com" target="_blank" rel="noreferrer">
            BscScan
          </a>
          <button className="footer-link-btn" onClick={() => setTab('terms')}>
            {t('nav.terms')}
          </button>
        </div>
        <div>{t('footer.routeNote')}</div>
        <div style={{ marginTop: 6, fontSize: 11 }}>{t('footer.chain', { id: CHAIN_ID })}</div>
      </footer>
    </div>
  )
}
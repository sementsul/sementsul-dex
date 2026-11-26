import { useState } from 'react'
import SwapCard from './components/SwapCard.jsx'
import RecentTrades from './components/RecentTrades.jsx'
import PoolsPage from './components/PoolsPage.jsx'
import KnowledgePage from './components/KnowledgePage.jsx'
import { useWallet } from './lib/useWallet.js'
import { shortAddress } from './lib/format.js'
import { CHAIN_ID } from './lib/chain.js'

const TABS = [
  { id: 'swap', label: 'Обмен' },
  { id: 'pools', label: 'Пулы' },
  { id: 'kb', label: 'База знаний' },
]

export default function App() {
  const wallet = useWallet()
  const [tab, setTab] = useState('swap')

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <img src="/sml-256.png" alt="Sementsul" onError={(e) => (e.currentTarget.style.display = 'none')} />
          <span>Sementsul</span>
          <span className="brand-sub">DEX</span>
        </div>

        <nav className="nav">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={tab === t.id ? 'nav-tab active' : 'nav-tab'}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {wallet.available ? (
          wallet.account ? (
            <button
              className="wallet-btn connected"
              onClick={wallet.disconnect}
              title="Нажмите, чтобы отключить"
            >
              <span className="dot" />
              <span className="mono">{shortAddress(wallet.account)}</span>
              {wallet.wrongChain && (
                <span style={{ color: 'var(--red)', fontSize: 11, fontWeight: 700 }}>НЕ ТА СЕТЬ</span>
              )}
            </button>
          ) : (
            <button className="wallet-btn" onClick={wallet.connect}>
              Подключить кошелёк
            </button>
          )
        ) : (
          <a className="wallet-btn" href="https://metamask.io/download/" target="_blank" rel="noreferrer">
            Установить MetaMask
          </a>
        )}
      </header>

      <main className="main">
        {tab === 'swap' && (
          <div className="main-col">
            <SwapCard wallet={wallet} />
            <RecentTrades />
          </div>
        )}
        {tab === 'pools' && <PoolsPage wallet={wallet} />}
        {tab === 'kb' && <KnowledgePage />}
      </main>

      <footer className="footer">
        <div className="footer-links">
          <a href="https://bscscan.com" target="_blank" rel="noreferrer">
            BscScan
          </a>
        </div>
        <div>Расчёт маршрута и цены выполняется в браузере. Транзакции подписывает ваш кошелёк.</div>
        <div style={{ marginTop: 6, fontSize: 11 }}>Chain ID {CHAIN_ID} · BNB Smart Chain</div>
      </footer>
    </div>
  )
}
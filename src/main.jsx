import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import { LangProvider } from './lib/useI18n.jsx'
import './styles.css'

// Провайдер языка стоит выше App, потому что язык нужен уже в шапке, а также
// в экране блокировки: он рендерится вместо всего приложения и тоже должен
// быть на выбранном языке.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <LangProvider>
      <App />
    </LangProvider>
  </React.StrictMode>
)
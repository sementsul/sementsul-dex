// Экран блокировки доступа из подсанкционной юрисдикции.
//
// Показывается вместо всего интерфейса, если /api/geo определил страну или
// регион под санкциями. Отдельный компонент, а не модалка: прятать за
// оверлеем бессмысленно, потому что под ним остаётся рабочий интерфейс,
// и его можно открыть, убрав элемент через devtools.
//
// Текст намеренно объясняет причину. «403 Forbidden» без пояснения человек
// примет за поломку сайта и пойдёт искать обход, а не поймёт ограничение.
//
// Язык берём из контекста, а не из браузера напрямую: пользователь мог
// переключить его вручную, и экран блокировки обязан это уважать.

import { BLOCKED_COUNTRIES } from '../lib/compliance.js'
import { useI18n } from '../lib/useI18n.jsx'

export default function BlockedScreen({ title, message, kind }) {
  const { lang, t } = useI18n()

  // Названия стран хранятся в compliance.js по-русски. Для английского
  // интерфейса подставляем свои: список короткий, и держать его рядом с
  // текстом проще, чем тащить в словарь ещё один слой.
  const COUNTRY_EN = {
    IR: 'Iran',
    KP: 'North Korea',
    SY: 'Syria',
    CU: 'Cuba',
  }
  const names = Object.entries(BLOCKED_COUNTRIES).map(
    ([code, ru]) => (lang === 'en' ? COUNTRY_EN[code] ?? ru : ru)
  )

  return (
    <div className="app">
      <div className="blocked-wrap">
        <div className="card blocked-card">
          <div className="blocked-icon" aria-hidden="true">
            ⛔
          </div>

          <h1 className="blocked-title">{title ?? t('blocked.title')}</h1>

          <p className="blocked-text">{message}</p>

          {kind === 'country' && (
            <p className="blocked-note">{t('blocked.countryNote', { list: names.join(', ') })}</p>
          )}

          {kind === 'region' && <p className="blocked-note">{t('blocked.regionNote')}</p>}

          <div className="blocked-links">
            <a href="https://github.com/sementsul/sementsul-dex" target="_blank" rel="noreferrer">
              {t('blocked.repo')}
            </a>
          </div>

          <p className="blocked-legal">{t('blocked.legal')}</p>
        </div>
      </div>
    </div>
  )
}
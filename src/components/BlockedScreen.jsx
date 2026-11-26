// Экран блокировки доступа из подсанкционной юрисдикции.
//
// Показывается вместо всего интерфейса, если /api/geo определил страну или
// регион под санкциями. Отдельный компонент, а не модалка: прятать за
// оверлеем бессмысленно, потому что под ним остаётся рабочий интерфейс,
// и его можно открыть, убрав элемент через devtools.
//
// Текст намеренно объясняет причину. «403 Forbidden» без пояснения человек
// примет за поломку сайта и пойдёт искать обход, а не поймёт ограничение.

import { BLOCKED_COUNTRIES } from '../lib/compliance.js'

export default function BlockedScreen({ title, message, kind }) {
  return (
    <div className="app">
      <div className="blocked-wrap">
        <div className="card blocked-card">
          <div className="blocked-icon" aria-hidden="true">
            ⛔
          </div>

          <h1 className="blocked-title">{title ?? 'Доступ ограничен'}</h1>

          <p className="blocked-text">{message}</p>

          {kind === 'country' && (
            <p className="blocked-note">
              Ограничение действует по стране подключения и не зависит от вашего
              кошелька или активов. Список юрисдикций: {Object.values(BLOCKED_COUNTRIES).join(', ')}.
            </p>
          )}

          {kind === 'region' && (
            <p className="blocked-note">
              Регион определён по IP-адресу. Если это ошибка, сообщите об этом в
              репозиторий проекта — определение по региону работает по названию
              области и может ошибаться.
            </p>
          )}

          <div className="blocked-links">
            <a href="https://github.com/sementsul/sementsul-dex" target="_blank" rel="noreferrer">
              Репозиторий проекта
            </a>
          </div>

          <p className="blocked-legal">
            Sementsul DEX — некастодиальный интерфейс к смарт-контрактам в BNB
            Chain. Контракты остаются общедоступными и не контролируются этим
            сайтом; ограничение относится к использованию интерфейса.
          </p>
        </div>
      </div>
    </div>
  )
}
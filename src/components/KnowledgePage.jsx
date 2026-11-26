import { useMemo, useState } from 'react'
import { ARTICLES, searchArticles } from '../lib/knowledge.js'

// База знаний: список статей и просмотр одной.
//
// Держим в одном компоненте, потому что переход между списком и статьёй —
// это состояние, а не маршрут: отдельная страница на каждую статью означала бы
// настройку роутера и ломала бы обновление по якорю.
export default function KnowledgePage() {
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState(null)

  const results = useMemo(() => searchArticles(query), [query])
  const open = openId ? ARTICLES.find((a) => a.id === openId) : null

  if (open) {
    return <Article article={open} onBack={() => setOpenId(null)} />
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">База знаний</h1>
          <p className="page-sub">
            Как работает биржа, откуда берётся доход и что может пойти не так.
          </p>
        </div>
      </div>

      <input
        className="search-input"
        placeholder="Поиск по статьям"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {results.length === 0 ? (
        <div className="empty-state">
          <p>По запросу «{query}» ничего не нашлось.</p>
          <button className="ghost-btn" onClick={() => setQuery('')}>
            Сбросить поиск
          </button>
        </div>
      ) : (
        <div className="kb-list">
          {results.map((a) => (
            <button key={a.id} className="kb-item" onClick={() => setOpenId(a.id)}>
              <span className="kb-item-head">
                <span className="kb-item-title">{a.title}</span>
                <span className="kb-tags">
                  {a.tags.map((t) => (
                    <span key={t} className="kb-tag">
                      {t}
                    </span>
                  ))}
                </span>
              </span>
              <span className="kb-item-summary">{a.summary}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// Адрес контракта в тексте статьи превращаем в ссылку на BscScan: читатель
// должен иметь возможность проверить сказанное, а не перепечатывать 42 символа
// руками — ошибка в одном знаке ведёт не туда.
//
// Разметку держим здесь, а не в knowledge.js: там тексты намеренно остаются
// простыми строками, их проверяет test-knowledge.mjs, и markdown внутри строк
// сломал бы и проверки, и поиск по статьям.
const ADDRESS_RE = /(0x[0-9a-fA-F]{40})/g

function linkify(text) {
  const parts = text.split(ADDRESS_RE)
  // split с группой кладёт совпадения на нечётные позиции
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <a
        key={i}
        className="kb-addr"
        href={`https://bscscan.com/address/${part}`}
        target="_blank"
        rel="noreferrer"
      >
        {part}
      </a>
    ) : (
      part
    )
  )
}

function Article({ article, onBack }) {
  return (
    <div className="page">
      <button className="back-btn" onClick={onBack}>
        ← Все статьи
      </button>

      <h1 className="page-title">{article.title}</h1>
      <p className="page-sub">{article.summary}</p>

      <div className="kb-tags" style={{ marginBottom: 20 }}>
        {article.tags.map((t) => (
          <span key={t} className="kb-tag">
            {t}
          </span>
        ))}
      </div>

      <article className="kb-article">
        {article.body.map((section, i) => (
          <section key={i}>
            <h2>{section.h}</h2>
            {section.p.map((text, j) => (
              <p key={j}>{linkify(text)}</p>
            ))}
          </section>
        ))}
      </article>
    </div>
  )
}
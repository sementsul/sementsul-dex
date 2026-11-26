import { useMemo, useState } from 'react'
import { ARTICLES, searchArticles } from '../lib/knowledge.js'
import { ARTICLES_EN, searchArticlesEn } from '../lib/knowledge.en.js'
import { useI18n } from '../lib/useI18n.jsx'

// База знаний: список статей и просмотр одной.
//
// Держим в одном компоненте, потому что переход между списком и статьёй —
// это состояние, а не маршрут: отдельная страница на каждую статью означала бы
// настройку роутера и ломала бы обновление по якорю.
//
// Статьи лежат двумя массивами, а не в словаре ui-строк: это длинные тексты
// со своей структурой (разделы, абзацы), и держать их рядом с подписями к
// кнопкам значило бы получить нечитаемый файл. Язык выбирает тот же ключ,
// что и весь интерфейс, поэтому база знаний не может «отстать» от него.
export default function KnowledgePage() {
  const { lang, t } = useI18n()
  const [query, setQuery] = useState('')
  const [openId, setOpenId] = useState(null)

  const articles = lang === 'en' ? ARTICLES_EN : ARTICLES
  const search = lang === 'en' ? searchArticlesEn : searchArticles

  const results = useMemo(() => search(query), [query, search])
  const open = openId ? articles.find((a) => a.id === openId) : null

  if (open) {
    return <Article article={open} onBack={() => setOpenId(null)} />
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1 className="page-title">{t('kb.title')}</h1>
          <p className="page-sub">{t('kb.sub')}</p>
        </div>
      </div>

      <input
        className="search-input"
        placeholder={t('kb.searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      {results.length === 0 ? (
        <div className="empty-state">
          <p>{t('kb.nothingFound', { query })}</p>
          <button className="ghost-btn" onClick={() => setQuery('')}>
            {t('kb.resetSearch')}
          </button>
        </div>
      ) : (
        <div className="kb-list">
          {results.map((a) => (
            <button key={a.id} className="kb-item" onClick={() => setOpenId(a.id)}>
              <span className="kb-item-head">
                <span className="kb-item-title">{a.title}</span>
                <span className="kb-tags">
                  {a.tags.map((tag) => (
                    <span key={tag} className="kb-tag">
                      {tag}
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
  const { t } = useI18n()

  return (
    <div className="page">
      <button className="back-btn" onClick={onBack}>
        {t('kb.backToAll')}
      </button>

      <h1 className="page-title">{article.title}</h1>
      <p className="page-sub">{article.summary}</p>

      <div className="kb-tags" style={{ marginBottom: 20 }}>
        {article.tags.map((tag) => (
          <span key={tag} className="kb-tag">
            {tag}
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